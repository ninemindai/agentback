# Deploy to a Web-standard runtime (Bun, Deno, Workers)

AgentBack's REST routes run on any runtime with a `fetch(Request): Response`
entry point — not just Node. `RestServer.fetchHandler()` returns the same
routing + Zod validation + DI + error-envelope pipeline as the Express server,
as a runtime-neutral handler.

> **Status (Stage 1, additive surface):** `fetchHandler()` dispatches `@api`
> routes (incl. streaming) and is parity-proven against Express. Middleware,
> auth, dispatch hooks, confirmation/idempotency, and uploads are currently
> served by the **Express** path only — see the
> [Fetch-seam spec](../superpowers/specs/2026-06-16-fetch-adapter-seam-design.md)
> for what's ported when. For routes needing those, deploy on Node (Express)
> today; the edge path grows as the cutover lands.

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
owns the listener.

## Bun

```ts
// bun run server.ts
Bun.serve({port: 3000, fetch: fetchHandler.fetch});
```

Bun's server *is* a fetch host — no adapter, no `@hono/node-server`. (Bun can
also run the full Express app via its `node:http` compat, which keeps the
Express-only features; `Bun.serve({fetch})` is the native, edge-shaped path.)

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
across requests. On Workers, `FileStore` should be R2 and any Node-only deps
must be avoided in the route handlers.

## Testing the handler in-process

No socket needed — `createTestApp` exposes a `fetch` client over the same
handler:

```ts
const t = await createTestApp(App);
const res = await t.fetch('/greet/Ada');
expect(res.status).toBe(200);
```

## One handler, three runtimes

Workers, Deno, and Bun all take the same `fetch(Request): Promise<Response>`,
so each deployment is a ~5-line wrapper around the one `fetchHandler`. The Zod
schemas, OpenAPI, and MCP projection are identical wherever it runs.
