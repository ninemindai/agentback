# hello-hosts

One AgentBack `@api` controller, served by **three different HTTP hosts** —
Fastify, Hono, and Bun — with no framework changes. The proof that
`RestServer.fetchHandler()` is a runtime-neutral `fetch(Request): Response`
that any host can drive.

## The shape

```
src/controller.ts   shared GreetController (@api, two routes) — host-agnostic
src/app.ts          builds the RestApplication with listen:false, returns its FetchHost
src/fastify.ts      installFastifyHost(fastify, host)            ← Fastify owns the port
src/hono.ts         hono.all('*', c => host.fetch(c.req.raw))    ← Hono owns the port
src/bun.ts          Bun.serve({fetch: host.fetch})               ← Bun owns the port
src/native.ts       new RestApplication({rest:{listener:'native'}}) ← AgentBack hosts itself
```

`controller.ts` and `app.ts` are **identical** across all three runs. Only the
host wrapper differs — and each wrapper is ~3 lines of glue.

| | Fastify | Hono | Bun |
| --- | --- | --- | --- |
| Host setup | `Fastify()` | `new Hono()` | `Bun.serve({…})` |
| AgentBack wiring | `installFastifyHost(fastify, host)` | `hono.all('*', c => host.fetch(c.req.raw))` | `fetch: host.fetch` |
| Own route precedence | wildcard fallback (non-greedy) | `hono.get('/native')` registered first | n/a |
| Runtime | Node | Node (`@hono/node-server`) / Bun / Deno | Bun |

## Run it

```bash
pnpm -F hello-hosts build         # compiles fastify/hono/native (not bun.ts)

pnpm -F hello-hosts start:fastify # → http://localhost:3000
pnpm -F hello-hosts start:hono    # → http://localhost:3000
pnpm -F hello-hosts start:native  # → http://localhost:3000 (no host framework)
bun run examples/hello-hosts/src/bun.ts   # Bun runs TS natively — no build step
```

`start:native` is the fourth option: no external framework at all.
`rest.listener: 'native'` (experimental) makes `RestServer.start()` serve
`fetchHandler()` through a Node `http` server directly — the runtime-neutral
Router is the single source of truth, the same surface the other three drive.
See [`docs/superpowers/specs/2026-06-16-fetch-seam-root-cutover.md`](../../docs/superpowers/specs/2026-06-16-fetch-seam-root-cutover.md).

Then, against whichever you started:

```bash
curl http://localhost:3000/greet/Ada
#   {"greeting":"Hello, Ada!"}
curl -X POST http://localhost:3000/echo \
  -H 'content-type: application/json' -d '{"message":"hi"}'
#   {"echoed":"hi"}
curl http://localhost:3000/openapi.json   # OpenAPI 3.1.1 — served via fetchHandler() too
curl http://localhost:3000/llms.txt       # AX machine-readable summary
curl http://localhost:3000/native         # the host's OWN route (Fastify/Hono only)
curl http://localhost:3000/missing
#   {"error":{"code":"not_found","message":"Not Found"}}
```

## Why `listen: false`

`new RestApplication({rest: {listen: false}})` wires every route but binds **no
TCP port** — the host runtime owns the listener. `app.start()` still runs the
full lifecycle (DI, route collection, OpenAPI emission); `server.fetchHandler()`
then hands you the `{fetch}` the host plugs in.

## What's served via `fetchHandler()`

Everything a plain REST app exposes: `@api` routes (with Zod validation, DI,
auth, dispatch hooks, confirmation/idempotency, streaming, uploads), the
`/openapi.json` document, and the `/llms.txt` AX artifacts. The install\* UI
packages (`rest-explorer`, `context-explorer`, …) also register onto this
surface, so they render on any host too.

The one piece **not** yet on the fetch surface is `@agentback/mcp-http`'s
Streamable HTTP transport — the MCP SDK's transport reads Node
`IncomingMessage`/`ServerResponse` directly. Run MCP-over-HTTP on the Node
(Express) host until that's bridged.

## See also

- [`docs/guides/deploy-to-edge.md`](../../docs/guides/deploy-to-edge.md) — HTTP hosts guide: Node/Fastify/Hono/Bun/Deno/Workers + MCP-over-HTTP
- `RestServer.fetchHandler()`, `installFastifyHost()`, `createNodeListener()` in `@agentback/rest`
