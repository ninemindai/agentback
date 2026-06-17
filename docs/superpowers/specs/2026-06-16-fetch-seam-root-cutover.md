# Fetch-seam root cutover — collapsing the dual router

> Status: **design note + flagged prototype**. The native-listener path exists
> behind `rest.listener: 'native'` (default `'express'`); this doc records why
> the full default cutover is still gated, and on what.

## The problem (root cause)

AgentBack currently maintains **two routing systems** for REST:

1. **Express** — the historical path. `RestServer` registers every `@api` route
   with `app[verb](...)`, plus framework routes (`/openapi.json`, `/llms.txt`),
   plus whatever the `install*` UI helpers and `mcp-http` mount on `expressApp`.
2. **`fetchHandler()`** — the runtime-neutral `fetch(Request): Response` added by
   the Fetch-seam backlog (A1–G, F1–F3). Drives Bun/Deno/Workers/Fastify/Hono.

Because both exist, **every route must be registered into both**. That is the
source of the dual-registration smell:

- `@api` routes — collected into the `fetchHandler()` Router *and* mounted on
  Express (and, in `dispatch: 'web'` mode, the Express handler internally
  reconstructs a Web `Request` and delegates to the same `RestHandler`).
- `/openapi.json`, `/llms.txt` — `mountFrameworkRoutes()` calls **both**
  `app.get(...)` and `addFetchHandler(...)`.
- `install*` UIs — dual-register `app.use`/`app.get` **and** `addFetchPrefix`/
  `addFetchHandler` (F2).

Each addition is a place to forget one half (we shipped `/openapi.json` missing
its fetch half — caught by `examples/hello-hosts/src/bun.ts` returning 404).

## The fix

Make `fetchHandler()` the **single router** and demote Express (and every other
host) to a thin Node adapter on top of it:

```
fetchHandler()  ←── @api routes + framework routes + install* UIs  (ONE registry)
   │
   ├── Node      http.createServer(createNodeListener(fetchHandler()))
   ├── Fastify   installFastifyHost(fastify, fetchHandler())
   ├── Bun       Bun.serve({fetch: fetchHandler().fetch})
   └── Workers   export default {fetch: fetchHandler().fetch}
```

`createNodeListener` (already shipped, via `@hono/node-server`) owns the
Node↔Web conversion — Set-Cookie multiplicity, client-abort, HEAD,
content-length, stream errors. So the Node host stops needing Express for
*routing*; Express, if present at all, becomes one optional middleware host.

`RestServer.start()` in native mode mounts
`http.createServer(createNodeListener(this.fetchHandler()))` instead of
`this.app.listen()`. The per-route `app[verb]` registration, the `dispatch:
'web'` Express-request-reconstruction shim, and the dual `addFetchHandler`
calls in `mountFrameworkRoutes`/`install*` all collapse into single
registrations on the fetch Router.

## What blocks making it the default

### 1. `@agentback/mcp-http` (hard blocker)

`mountMcpHttp` calls
`transport.handleRequest(req, res, req.body)` where `transport` is the MCP SDK's
`StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk`). `handleRequest`
takes a Node `IncomingMessage` + `ServerResponse` directly — it writes to the
socket itself (SSE streaming, session headers). There is no
`fetch(Request): Response` form in the SDK today.

**Options, in preference order:**

- **(a) Upstream:** file an issue / PR on `@modelcontextprotocol/sdk` for a
  Web-transport variant of `StreamableHTTPServerTransport` (a
  `handle(Request): Response` returning a streamed `Response`). Cleanest; lets
  `mcp-http` register a single fetch handler like everything else.
- **(b) Bridge:** wrap the Node transport behind a Web→Node shim — synthesize an
  `IncomingMessage` from the Web `Request` and a `ServerResponse` that writes
  into a `ReadableStream` we hand back as the `Response` body. Doable but fiddly
  (the SSE keep-alive + session lifecycle must survive the bridge); it is the
  same class of adapter `@hono/node-server` already implements in reverse.
- **(c) Keep `mcp-http` Node-only:** native mode supports everything *except*
  MCP-over-HTTP; apps needing it stay on the Express host. This is the current
  prototype's stance.

### 2. Express-coupled escape hatches

Routes that `@inject(HTTP_REQUEST/HTTP_RESPONSE)` for raw req/res, and
subclasses overriding the Express dispatch seam (`dispatch`/`sendResult`/…),
are inherently Express-bound. The `dispatch: 'web'` flag already detects these
statically (`injectsRawExpressObjects`, `overridesExpressDispatchSeam`) and
keeps them on Express. Native mode must refuse to start (loud error) when such a
route is present, rather than silently dropping it — these callers opted into
Express semantics.

### 3. `app.expressMiddleware` / the LB4 middleware chain

The Express-typed middleware chain (`MiddlewareContext` with Express
`req`/`res`) only runs on the Express host. Native mode runs the neutral
`WebMiddleware` onion (`app.webMiddleware`) instead — already at parity for CORS
+ user entries (item B). An app relying on `expressMiddleware` for a route stays
on the Express host until that middleware is re-expressed as `WebMiddleware`.

## Prototype (this change)

`rest.listener: 'express' | 'native'` (default `'express'`):

- `'express'` — unchanged. `start()` binds `this.app.listen(...)`.
- `'native'` — `start()` builds `this.fetchHandler()` and serves it via
  `http.createServer(createNodeListener(...))`. Express routes are still mounted
  (so `expressApp` stays usable as an escape hatch for a manually-driven
  sub-app) but are **not** what the listener serves. `mcp-http` and raw-req/res
  routes are unsupported in this mode and documented as such.

A parity integration test boots the same controller under both listeners and
asserts identical responses for `@api` routes, `/openapi.json`, and a 404.

## Exit criteria for flipping the default

1. MCP SDK Web-transport (option a) lands, or the bridge (option b) ships with
   its own conformance test.
2. Native mode throws at `start()` on Express-coupled routes (done in prototype).
3. The full existing `@agentback/rest` + examples suite passes with
   `listener: 'native'` as default (the same full-suite gate item D used).
