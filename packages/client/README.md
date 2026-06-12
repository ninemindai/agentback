# @agentback/client

Tiny, schema-typed HTTP client for any AgentBack server. No codegen,
no spec round-trip — server and client import the **same Zod schemas** and
the schema _is_ the contract.

- ESM-only, Node 22.13+
- Zero runtime deps (peer-dep: `zod ^4`)
- Native `fetch` (no axios, no node-fetch shim)
- Browser-safe — no `@agentback/openapi` runtime, no decorators

```bash
pnpm add @agentback/client zod
```

## At a glance

```ts
import {z} from 'zod';
import {createClient, defineRoute} from '@agentback/client';

// Share these with the server. In a monorepo, put them in their own file
// or workspace package — never in the server's main entry, or importing
// the schemas would also start the server.
const HelloPath = z.object({name: z.string().min(1)});
const Greeting = z.object({greeting: z.string()});

const hello = defineRoute('GET', '/greet/hello/{name}', {
  path: HelloPath,
  response: Greeting,
});

const client = createClient({baseURL: 'http://localhost:3000'});
const out = await hello.call(client, {path: {name: 'Alice'}});
//    ^^^  inferred as {greeting: string} — validated at runtime
```

## Why this design

A typical SDK toolchain (`openapi-generator`, Stainless, Fern) generates a
client off the server's OpenAPI spec. That works for cross-language
consumers, but in a TypeScript monorepo it adds:

1. A build step that has to run on every server change.
2. A generated artifact that drifts whenever someone edits the spec by hand.
3. Two sources of truth: the Zod schemas the server validates against, and
   the TS interfaces the generator emits.

This client skips all of that. Both ends import the _same_ `z.ZodType`,
so:

- Types are inferred (`z.infer<typeof Schema>`), not generated.
- Runtime validation is the same validator the server uses.
- A schema change is a single edit — TS catches drift at the call site.
- No build step, no toolchain, no spec round-trip.

The cost: this only works for TypeScript consumers. Non-TS clients (Python,
Go, Swift) still want spec-based codegen — feed them `/openapi.json` and
any standard generator works.

## API

### `createClient(config)`

```ts
const client = createClient({
  baseURL: 'http://api.example.com',
  headers: () => ({authorization: `Bearer ${getToken()}`}), // sync or async
  timeoutMs: 5_000, // default per-request timeout
  fetch: customFetch, // optional: instrument / proxy / mock
});
```

Header sources can be a plain object or a (sync/async) function — use the
function form when tokens refresh.

### `defineRoute(method, path, schemas)`

Captures the route's HTTP method, OpenAPI-style path template, and the Zod
schemas it accepts/returns. Returns a `RouteHandle` with these methods:

| Method                           | Returns                   | Throws?                    | Notes                       |
| -------------------------------- | ------------------------- | -------------------------- | --------------------------- |
| `call(client, input, opts?)`     | `Promise<Output>`         | `ClientError`              | Standard execution.         |
| `safeCall(client, input, opts?)` | `Promise<Result<Output>>` | never                      | Mirrors Zod's `safeParse`.  |
| `url(client, input)`             | `string`                  | `ClientError` on bad input | Compose URL without firing. |

The `schemas` object shape:

```ts
{
  path?:      ZodObject     // URL placeholders, e.g. /users/{id}
  query?:     ZodObject     // querystring
  headers?:   ZodObject     // lowercase keys to match server validation
  body?:      ZodType       // request body (JSON)
  response?:  ZodType       // success body — validated at runtime
  responses?: Record<number, ZodType>  // typed schemas for non-2xx bodies
}
```

The input shape `.call(client, input)` requires is _conditional on what
you declared_: pass `{path: {name}}` for path-only, `{path, body}` for
both, nothing for none.

### `routeGroup(prefix)`

Share a path prefix across multiple routes:

```ts
const auth = routeGroup('/auth');
const login = auth.post('/login', {body: LoginIn, response: LoginOut});
const me = auth.get('/me', {response: Me});

// Nestable:
const apiV1 = routeGroup('/api').group('/v1');
```

Verb shortcuts: `.get`, `.post`, `.put`, `.patch`, `.delete`, `.head`.
Use `.route(method, path, schemas)` for anything else. All accept an
optional `schemas` argument that defaults to `{}`.

### `safeCall`: branching without try/catch

```ts
const result = await secret.safeCall(client);
if (!result.success) {
  if (result.error.status === 401) return signIn();
  throw result.error;
}
console.log(result.data);
```

### Typed error bodies

Declare schemas for non-2xx responses you care about:

```ts
const ValidationError = z.object({
  error: z.object({
    statusCode: z.literal(422),
    message: z.string(),
    details: z.array(z.object({path: z.array(z.string()), code: z.string()})),
  }),
});

const create = defineRoute('POST', '/items', {
  body: NewItem,
  response: Item,
  responses: {422: ValidationError},
});

try {
  await create.call(client, {body: input});
} catch (err) {
  if (err instanceof ClientError && err.status === 422 && err.parsedBody) {
    // err.parsedBody is the parsed ValidationError shape
  }
}
```

`parsedBody` is set only when the response status matches a declared
schema _and_ the body parses. Otherwise `body` (raw JSON) is still there.

### Timeouts & cancellation

```ts
await hello.call(client, {path: {name: 'x'}}, {timeoutMs: 2_000});
// or pass your own signal:
const ac = new AbortController();
setTimeout(() => ac.abort(), 1_000);
await hello.call(client, {path: {name: 'x'}}, {signal: ac.signal});
```

Precedence: explicit `signal` > per-call `timeoutMs` > client `timeoutMs` >
no timeout.

### `url(client, input)`

For prefetch links, logs, or building `<a href>` targets without firing:

```ts
const href = hello.url(client, {path: {name: 'Alice'}});
// 'http://api.example.com/greet/hello/Alice'
```

## The schema-sharing pattern

In a monorepo, put shared schemas in their own module — not in the
server's main entry, which would run on import:

```
packages/
  api-schemas/        # exports Zod schemas only — no runtime side effects
  api-server/         # imports schemas, mounts controllers
  api-client/         # imports schemas, exports defineRoute handles
apps/
  web/                # depends on api-client
  worker/             # depends on api-client
```

The `examples/hello-rest` + `examples/hello-client` pair in this repo
shows the simplest version (server exposes schemas via a subpath export).

## Error model

All failures throw (or, with `safeCall`, return) a `ClientError`:

```ts
interface ClientError extends Error {
  status: number; // HTTP status, or 0 for network / pre-flight errors
  body: unknown; // raw response body (parsed as JSON if possible)
  response?: Response; // the underlying Fetch Response (when one exists)
  parsedBody?: unknown; // body parsed against responses[status] schema, if declared
}
```

`status === 0` means: input failed Zod validation, fetch threw at the
network level, or the request was aborted/timed out.
