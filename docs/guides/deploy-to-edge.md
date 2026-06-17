# HTTP hosts: Node, Fastify, Hono, Bun, Deno, Workers

AgentBack's REST **and** MCP surfaces run on any runtime with a
`fetch(Request): Response` entry point — not just Node/Express.
`RestServer.fetchHandler()` returns the same routing + Zod validation + DI +
auth + dispatch hooks + confirmation/idempotency + streaming + uploads +
error-envelope pipeline as the Express server, as a runtime-neutral handler.
One app, hosted by whatever owns the port.

> A polished, standalone version of this diagram lives at
> [`../architecture/diagrams/http-hosts.html`](../architecture/diagrams/http-hosts.html)
> — open it in a browser (with Copy / PNG / PDF export).

```mermaid
graph TD
  subgraph App["RestApplication — one DI Context"]
    Ctrls["@api controllers"]
    Tools["@tool classes (MCP)"]
    UIs["install* UIs<br/>(explorer, console…)"]
    FW["/openapi.json · /llms.txt"]
  end

  App --> FH["RestServer.fetchHandler()<br/><b>fetch(Request): Response</b>"]
  Ctrls --> FH
  Tools -->|mountMcpHttpFetch| FH
  UIs -->|addFetchPrefix| FH
  FW --> FH

  FH --> Node["Node http<br/>(listener: 'native')"]
  FH --> Fastify["Fastify<br/>installFastifyHost"]
  FH --> Hono["Hono<br/>hono.all('*', …)"]
  FH --> Bun["Bun.serve({fetch})"]
  FH --> Deno["Deno.serve(fetch)"]
  FH --> CF["Cloudflare Workers<br/>export default {fetch}"]
```

> **Status:** the fetch path is at **parity** with the Express path — `@api`
> routes (incl. streaming + uploads), authentication/authorization, dispatch
> hooks, confirmation/idempotency, the `/openapi.json` + `/llms.txt` documents,
> the `install*` UIs, and **MCP-over-HTTP** (via `mountMcpHttpFetch`, incl. OAuth
> bearer + strategy auth). The runnable comparison is
> [`examples/hello-hosts`](../../examples/hello-hosts/README.md). The Express
> listener remains the default; `rest.listener: 'native'` opts into the
> fetch-driven Node listener. See the
> [root-cutover spec](../superpowers/specs/2026-06-16-fetch-seam-root-cutover.md)
> for what stays Express-only (raw `@inject(HTTP_REQUEST/HTTP_RESPONSE)` routes
> and dispatch-seam subclasses).

## The handler

```ts
import {RestApplication} from '@agentback/rest';

const app = new RestApplication({rest: {listen: false}}); // no TCP listener
app.restController(MyController);
await app.start();                                         // mounts routes
const server = await app.getServer('RestServer');
export const fetchHandler = server.fetchHandler();         // {fetch}
```

`listen: false` makes `start()` wire every route but bind no port — the runtime
owns the listener. `fetchHandler()` is also exposed in tests via
`createTestApp(App).fetch(...)` (no socket needed).

## How a request flows on the fetch path

```mermaid
graph LR
  Req["Request"] --> Onion["WebMiddleware onion<br/>(CORS + app.webMiddleware)"]
  Onion --> Router["Router.match<br/>(compiled regex)"]
  Router -->|api route| RH["RestHandler<br/>auth → authz → confirm →<br/>validate → DI invoke →<br/>output validate → idem"]
  Router -->|no match| NF["exact / prefix handlers<br/>(UIs, /openapi.json, MCP)"]
  RH --> Res["Response"]
  NF --> Res
```

The same `RestHandler` runs whether the host is Node, Bun, Fastify, or a Worker —
only the outer adapter (Node↔Web bridge) differs.

## Native (no host framework)

`rest.listener: 'native'` serves `fetchHandler()` through a Node `http` server
directly — no Express in the request path. The runtime-neutral Router is the
single source of truth.

```ts
const app = new RestApplication({rest: {listener: 'native'}});
app.restController(MyController);
await app.start();   // binds http.createServer(createNodeListener(fetchHandler()))
```

`start()` throws if a route opts into Express semantics (raw req/res injection or
a dispatch-seam subclass) — those need the default `'express'` listener.

## Fastify

```ts
import Fastify from 'fastify';
import {installFastifyHost} from '@agentback/rest';

const app = new RestApplication({rest: {listen: false}});
app.restController(MyController);
await app.start();
const server = await app.getServer('RestServer');

const fastify = Fastify();
fastify.get('/native', async () => ({from: 'fastify'})); // Fastify-native route
installFastifyHost(fastify, server.fetchHandler());       // non-greedy fallback
await fastify.listen({port: 3000});
```

`installFastifyHost` mounts AgentBack as a **non-greedy fallback** (a wildcard
route inside an encapsulated plugin scope), so any Fastify-native route or plugin
front-runs it. `fastify` is a peer/dev dependency — never a hard runtime dep.

## Hono

```ts
import {Hono} from 'hono';
import {serve} from '@hono/node-server'; // or Bun.serve / Deno.serve

const hono = new Hono();
hono.get('/native', c => c.json({from: 'hono'})); // Hono-native route, runs first
hono.all('*', c => fetchHandler.fetch(c.req.raw)); // everything else → AgentBack
serve({fetch: hono.fetch, port: 3000});
```

`c.req.raw` is the underlying WHATWG `Request` — exactly what `fetchHandler`
expects.

## Bun

```ts
Bun.serve({port: 3000, fetch: fetchHandler.fetch});
```

Bun's server *is* a fetch host — no adapter, no `@hono/node-server`. Its `fetch`
field IS the `FetchHost` interface.

## Deno

```ts
Deno.serve({port: 3000}, fetchHandler.fetch);
```

## Cloudflare Workers

```ts
export default {
  fetch(request: Request): Promise<Response> {
    return fetchHandler.fetch(request);
  },
};
```

Build the app once at module scope (cold start), then reuse `fetchHandler`
across requests. On Workers, `FileStore` should be R2 and any Node-only deps must
be avoided in the route handlers.

## MCP-over-HTTP on any host

`installMcpHttp(app)` auto-selects the transport for the host: in
`listener: 'native'` it mounts the fetch-native
`mountMcpHttpFetch` (the SDK's `WebStandardStreamableHTTPServerTransport`);
otherwise the Express transport. Either way, the same `@tool`/`@resource` surface
is reachable by remote MCP clients, with OAuth bearer or strategy auth.

```ts
import {installMcpHttp} from '@agentback/mcp-http';

const app = new RestApplication({rest: {listener: 'native'}});
app.component(MCPComponent);
app.service(MyTools);
await installMcpHttp(app);   // POST/GET/DELETE /mcp on the fetch path
await app.start();
```

To drive it on Bun/Fastify/Hono (where you own the listener), call
`mountMcpHttpFetch(mcp, server, options)` before `app.start()`, then host
`server.fetchHandler()` as above.

## Testing the handler in-process

No socket needed — `createTestApp` exposes a `fetch` client over the same
handler:

```ts
const t = await createTestApp(App);
const res = await t.fetch('/greet/Ada');
expect(res.status).toBe(200);
```

## One handler, every runtime

Node, Fastify, Hono, Bun, Deno, and Workers all take the same
`fetch(Request): Promise<Response>`, so each deployment is a thin wrapper around
the one `fetchHandler`. The Zod schemas, OpenAPI, MCP projection, auth, and error
envelopes are identical wherever it runs.
