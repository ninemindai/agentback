# hello-client

> `@agentback/client` driving a running [`hello-rest`](../hello-rest) server with the server's own Zod schemas — no codegen, no generated SDK, no spec round-trip.

The client imports the very same schema objects from
[`hello-rest/src/schemas.ts`](../hello-rest/src/schemas.ts) that the server's
decorators use, so request/response types are inferred end-to-end
(`defineRoute` + `routeGroup` + `safeCall` with typed `responses[status]`).
Change a schema and both ends move together at compile time.

## Run

```bash
pnpm build                 # from the repo root
pnpm -F hello-rest start   # terminal 1 — the server
pnpm -F hello-client start # terminal 2 — this client
```

The script walks the hello-rest surface: hello/echo round-trips, JWT login,
authenticated calls, and typed error envelopes on the failure paths.
