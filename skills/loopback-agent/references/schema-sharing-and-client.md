# Schema Sharing and the Typed HTTP Client

## Table of Contents

- [The Thesis](#the-thesis)
- [The Schema Module Pattern](#the-schema-module-pattern)
- [createClient](#createclient)
- [defineRoute](#defineroute)
- [routeGroup](#routegroup)
- [safeCall and Typed Error Bodies](#safecall-and-typed-error-bodies)
- [End-to-End Example](#end-to-end-example)
- [Key Rules](#key-rules)

## The Thesis

Both the server and the client import the **same** `z.ZodType` schema objects.
No codegen, no spec round-trip, no generated TS interfaces. Types are inferred
via `z.infer<typeof Schema>`, and runtime validation on both sides runs the same
validator. A schema change is a single edit; TypeScript catches drift at the
call site before any test runs.

`@agentback/client` has zero runtime dependencies beyond `zod`. It uses
native `fetch` and carries no `@agentback/openapi` import — making it
browser-safe and usable against any OpenAPI/Zod-shaped server.

## The Schema Module Pattern

Never export schemas from the server's main entry point. Importing that module
would trigger application startup. Instead, put schemas in their own file and
import them from both ends.

In the `hello-rest` / `hello-client` example pair, the server exposes a
subpath export `hello-rest/schemas`:

```ts
// examples/hello-rest/src/schemas.ts
import {z} from 'zod';

export const HelloPath = z.object({name: z.string().min(1).max(64)});
export const Greeting = z.object({greeting: z.string()});

export const EchoIn = z.object({text: z.string().min(1).max(280)});
export const EchoOut = z.object({echoed: z.string(), at: z.string()});

export const LoginIn = z.object({
  username: z.string().min(1),
  roles: z.array(z.string()).optional(),
});
export const LoginOut = z.object({token: z.string()});

export const Me = z.object({
  id: z.string(),
  name: z.string(),
  roles: z.array(z.string()),
});
export const Secret = z.object({secret: z.string()});
```

The server imports the schemas for its decorators:

```ts
// examples/hello-rest/src/index.ts (excerpt)
import {HelloPath, Greeting, EchoIn, EchoOut} from './schemas.js';

@api({basePath: '/greet'})
class GreetingController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text, at: new Date().toISOString()};
  }
}
```

The client imports the exact same schemas — no duplication, no drift:

```ts
// examples/hello-client/src/index.ts (excerpt)
import {HelloPath, Greeting, EchoIn, EchoOut} from 'hello-rest/schemas';
```

In a larger monorepo, move schemas to a dedicated workspace package
(e.g. `packages/api-schemas`) so both `api-server` and any number of
consumers depend on it without a circular edge.

## createClient

```ts
import {createClient} from '@agentback/client';

const client = createClient({
  baseURL: 'http://localhost:3000',
  headers: () => ({authorization: `Bearer ${getToken()}`}), // sync or async
  timeoutMs: 5_000,
  fetch: customFetch, // optional — for instrumentation, mocking, or proxying
});
```

`headers` accepts a plain object or a (sync/async) function. Use the function
form for refreshable auth tokens. The returned `Client` exposes `baseURL`,
`fetch`, `defaultTimeoutMs`, and `resolveHeaders()`.

## defineRoute

`defineRoute(method, path, schemas)` captures the HTTP method, an OpenAPI-style
path template, and the Zod schemas for each slot. It returns a `RouteHandle`.

```ts
import {defineRoute} from '@agentback/client';

const hello = defineRoute('GET', '/greet/hello/{name}', {
  path: HelloPath, // ZodObject — URL placeholders
  response: Greeting, // ZodType   — success body, validated at runtime
});
```

The full `RouteSchemas` shape:

| Field       | Type                      | Purpose                                     |
| ----------- | ------------------------- | ------------------------------------------- |
| `path`      | `ZodObject`               | URL placeholders (e.g. `/users/{id}`)       |
| `query`     | `ZodObject`               | Querystring parameters                      |
| `headers`   | `ZodObject`               | Request headers (use lowercase keys)        |
| `body`      | `ZodType`                 | Request body, serialized as JSON            |
| `response`  | `ZodType`                 | Success body — validated on every response  |
| `responses` | `Record<number, ZodType>` | Per-status schemas for non-2xx error bodies |

The input shape required by `.call(client, input)` is conditional: only the
keys whose schemas are declared appear. Declare `{path, body}` → pass
`{path: {...}, body: {...}}`; declare nothing → call with no input argument.
TypeScript enforces this at the call site.

A `RouteHandle` has three methods:

| Method                           | Returns                   | Throws?                    |
| -------------------------------- | ------------------------- | -------------------------- |
| `call(client, input, opts?)`     | `Promise<Output>`         | `ClientError`              |
| `safeCall(client, input, opts?)` | `Promise<Result<Output>>` | never                      |
| `url(client, input)`             | `string`                  | `ClientError` on bad input |

`.url()` is synchronous — it validates path and query slots, expands the
template, and returns the full URL without firing a request. Use it for
prefetch links, logs, or `<a href>` targets.

## routeGroup

`routeGroup(prefix)` prepends a path prefix to every route defined in the
group, mirroring `@api({basePath: '...'})` on the server side.

```ts
import {routeGroup} from '@agentback/client';
import {
  HelloPath,
  Greeting,
  EchoIn,
  EchoOut,
  LoginIn,
  LoginOut,
  Me,
  Secret,
} from 'hello-rest/schemas';

const greet = routeGroup('/greet');
const auth = routeGroup('/auth');

const hello = greet.get('/hello/{name}', {path: HelloPath, response: Greeting});
const echo = greet.post('/echo', {body: EchoIn, response: EchoOut});
const login = auth.post('/login', {body: LoginIn, response: LoginOut});
const me = auth.get('/me', {response: Me});
const secret = auth.get('/secret', {response: Secret});
```

Verb shortcuts: `.get`, `.post`, `.put`, `.patch`, `.delete`, `.head`. Use
`.route(method, path, schemas)` for anything else. All accept an optional
`schemas` argument that defaults to `{}`. Note the asymmetry with the server:
the REST decorator for DELETE is `del` (since `delete` is a reserved word), but
the client verb shortcut is `.delete`.

Groups compose: `routeGroup('/api').group('/v1').get('/users', ...)` registers
the path `/api/v1/users`.

## safeCall and Typed Error Bodies

`safeCall` returns a discriminated `Result` — `{success: true, data}` or
`{success: false, error}` — instead of throwing. It mirrors Zod's `safeParse`
so call sites can branch on expected non-2xx responses without try/catch.

```ts
const result = await secret.safeCall(anon);
if (!result.success) {
  if (result.error.status === 401) return signIn();
  throw result.error; // unexpected — rethrow
}
console.log(result.data); // typed as {secret: string}
```

For typed error bodies, declare a schema in `responses`:

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

`ClientError` fields:

| Field        | Type                    | Notes                                                                      |
| ------------ | ----------------------- | -------------------------------------------------------------------------- |
| `status`     | `number`                | HTTP status, or `0` for network / pre-flight / validation errors           |
| `body`       | `unknown`               | Raw response body (parsed as JSON when possible)                           |
| `response`   | `Response \| undefined` | The underlying Fetch Response when one exists                              |
| `parsedBody` | `unknown \| undefined`  | Body parsed against `responses[status]` schema, if declared and successful |

`status === 0` means: input failed client-side Zod validation, `fetch` threw at
the network level, or the request was aborted or timed out.

Per-call timeouts and cancellation:

```ts
// Override the client's default timeout on a single call:
await hello.call(client, {path: {name: 'x'}}, {timeoutMs: 2_000});

// Bring your own AbortSignal:
const ac = new AbortController();
setTimeout(() => ac.abort(), 1_000);
await hello.call(client, {path: {name: 'x'}}, {signal: ac.signal});
```

Precedence: explicit `signal` > per-call `timeoutMs` > client `timeoutMs` > no
timeout.

## End-to-End Example

This is the minimal path from shared schema to a fully type-safe server +
client pair.

**`src/schemas.ts`** — the single source of truth, no side effects:

```ts
import {z} from 'zod';

export const ItemId = z.object({id: z.string().uuid()});
export const NewItem = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
});
export const Item = NewItem.extend({
  id: z.string().uuid(),
  createdAt: z.string(),
});
```

**`src/controller.ts`** — server imports schemas, derives handler types:

```ts
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {Item, ItemId, NewItem} from './schemas.js';

@api({basePath: '/items'})
export class ItemController {
  @post('/', {body: NewItem, response: Item, status: 201})
  async create(input: {
    body: z.infer<typeof NewItem>;
  }): Promise<z.infer<typeof Item>> {
    const id = crypto.randomUUID();
    return {id, ...input.body, createdAt: new Date().toISOString()};
  }

  @get('/{id}', {path: ItemId, response: Item})
  async getOne(input: {
    path: z.infer<typeof ItemId>;
  }): Promise<z.infer<typeof Item>> {
    return store.get(input.path.id); // your lookup; must satisfy Item
  }
}
```

**`src/client.ts`** — client imports the same schemas, no codegen:

```ts
import {createClient, routeGroup} from '@agentback/client';
import {Item, ItemId, NewItem} from './schemas.js'; // SAME import, no duplication

const items = routeGroup('/items');

const createItem = items.post('/', {body: NewItem, response: Item});
const getItem = items.get('/{id}', {path: ItemId, response: Item});

const client = createClient({baseURL: 'http://localhost:3000'});

const created = await createItem.call(client, {
  body: {name: 'Widget', price: 9.99},
});
// created is inferred as {id: string, name: string, price: number, createdAt: string}

const fetched = await getItem.call(client, {path: {id: created.id}});
// fetched is the same inferred type — validated at runtime
```

## Key Rules

- **Put schemas in their own module.** Never in the server's entry point — that would drag in controllers and start the server on import.
- **Both ends use `z.infer<typeof Schema>`.** No separate TS interfaces, no generated types. A schema change propagates to both sides automatically.
- **`@agentback/client` is browser-safe.** It imports only `zod` and uses native `fetch`. Never import server packages from client code.
- **`routeGroup` prefix mirrors `@api({basePath})`.** Keep them in sync manually — the client does not read the server's decorator metadata at runtime.
- **Header schemas use lowercase keys** on both sides. The server normalizes incoming header names before validation; `createClient` does the same before sending.
- **`status === 0` is always a client-side failure** — input validation, network error, abort, or timeout. HTTP errors have a real status code.
- **`safeCall` for expected non-2xx paths.** Use it when a 401 or 404 is a normal branch in your logic, not an exception.
- **`responses[status]` for typed error shapes.** Declare the schema; the parsed value appears on `ClientError.parsedBody` when the status matches and parsing succeeds.
