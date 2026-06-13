# REST and OpenAPI

## Table of Contents

- [Overview](#overview)
- [Defining a Controller](#defining-a-controller)
- [Verb Decorators and Route Options](#verb-decorators-and-route-options)
- [Slot-0: The Input Bundle](#slot-0-the-input-bundle)
- [Response Validation and Status Codes](#response-validation-and-status-codes)
- [URL Placeholders and Header Keys](#url-placeholders-and-header-keys)
- [Request Pipeline](#request-pipeline)
- [OpenAPI 3.1 Emission](#openapi-31-emission)
- [Swagger UI Explorer](#swagger-ui-explorer)
- [CORS and Middleware](#cors-and-middleware)
- [Subclassing RestServer](#subclassing-restserver)
- [End-to-End Example](#end-to-end-example)
- [Key Rules Recap](#key-rules-recap)

## Overview

`@agentback/rest` is a slim Express wrapper that routes requests to
controller methods, validates every request and response against Zod schemas
declared on HTTP verb decorators, and serves a live OpenAPI 3.1.1 document at
`/openapi.json`. There are no sequences or action chains — `RestServer.dispatch`
is a single fixed pipeline. Per-route customization lives on decorator options;
cross-cutting concerns go in Express middleware; deeper changes come from
subclassing `RestServer`.

Schemas are placed directly on verb decorators — there are no separate
`@param`, `@requestBody`, or `@response` decorators. The Zod schema is the
single source of truth for validation, TypeScript types, and the emitted
OpenAPI spec.

## Defining a Controller

Tag a class with `@api` to set its base path and spec-level metadata, then
register it with `app.restController()`:

```ts
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';

const HelloPath = z.object({name: z.string().min(1).max(64)});
const Greeting = z.object({greeting: z.string()});

@api({basePath: '/greet', tags: ['greet']})
class GreetingController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }
}

const app = new RestApplication({rest: {port: 3000, cors: true}});
app.restController(GreetingController);
await app.start();
// GET /greet/hello/Alice → {"greeting":"Hello, Alice!"}
// GET /openapi.json      → OpenAPI 3.1.1 document
```

`RestApplication` is an `Application` subclass with `MiddlewareMixin`
pre-applied. It pre-binds `RestServer` and exposes `app.restController()`,
`app.middleware()`, and `app.expressMiddleware()`.

## Verb Decorators and Route Options

Import verb decorators from `@agentback/openapi`:

```ts
import {get, post, put, patch, del, operation} from '@agentback/openapi';
```

`operation(verb, path, options?)` is the generic form for any verb. The
shorthand aliases (`get`, `post`, `put`, `patch`, `del`) cover the common cases.

All accept a `RouteOptions` object as their second argument:

| Option        | Type                                      | Description                                                           |
| ------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `body`        | `ZodType`                                 | Request body; validated body exposed as `input.body`                  |
| `path`        | `ZodObject`                               | URL placeholder values; exposed as `input.path`                       |
| `query`       | `ZodObject`                               | Query string values; exposed as `input.query`                         |
| `headers`     | `ZodObject`                               | Request headers (lowercase keys); exposed as `input.headers`          |
| `response`    | `ZodType`                                 | Success response schema; constrains return type; validated at runtime |
| `responses`   | `Record<number, {schema?, description?}>` | Additional documented status codes                                    |
| `status`      | `number`                                  | Success status code (default `200`; `204` returns empty body)         |
| `description` | `string`                                  | OpenAPI operation description                                         |
| `summary`     | `string`                                  | OpenAPI operation summary                                             |
| `tags`        | `string[]`                                | OpenAPI operation tags                                                |

Only the keys you declare are present in the input bundle at runtime.

## Slot-0: The Input Bundle

**When any of `body`, `path`, `query`, or `headers` is declared, the validated
bundle `{body, path, query, headers}` (only the declared keys) is injected as
slot 0.** The TypeScript type is derived via `z.infer` at compile time — a
wrong parameter type errors at the decorator site.

```ts
const ItemId = z.object({id: z.string().uuid()});
const NewItem = z.object({name: z.string(), qty: z.number().int()});
const Item = NewItem.extend({id: z.string().uuid()});

@api({basePath: '/items'})
class ItemController {
  // Slot 0 = {path: {id: string}}
  @get('/{id}', {path: ItemId, response: Item})
  async find(input: {path: z.infer<typeof ItemId>}) {
    return {id: input.path.id, name: 'example', qty: 1};
  }

  // Slot 0 = {body: {name: string; qty: number}}
  @post('/', {body: NewItem, response: Item, status: 201})
  async create(input: {body: z.infer<typeof NewItem>}) {
    return {id: crypto.randomUUID(), ...input.body};
  }
}
```

**When no schemas are declared, slot 0 is unconstrained.** Fully inject-driven
routes work without any Zod schema. (In the snippets below, `@inject` is from
`@agentback/core`; `SecurityBindings`, `UserProfile`, and `securityId` from
`@agentback/security`; `@authenticate` from `@agentback/authentication`
— see [auth-and-rate-limiting.md](auth-and-rate-limiting.md).)

```ts
@get('/whoami')
async whoami(@inject(SecurityBindings.USER) user: UserProfile) {
  return {id: user[securityId]};
}
```

**`@inject` must be at slot 1+ when any input schema is declared.** Placing
`@inject` at slot 0 alongside a schema throws at decoration time, naming the
class, method, and verb in the error:

```ts
// ERROR: slot 0 is reserved for the input bundle
@get('/me', {response: Me})
async me(
  @inject(SecurityBindings.USER) user: UserProfile,  // ← slot 0, throws
): Promise<z.infer<typeof Me>> { ... }

// CORRECT: input bundle at slot 0, @inject at slot 1
@get('/me', {response: Me})
async me(
  input: {},                                          // ← slot 0 (no schemas used here)
  @inject(SecurityBindings.USER) user: UserProfile,  // ← slot 1
): Promise<z.infer<typeof Me>> { ... }

// CORRECT: no input schemas, @inject is free at slot 0
@authenticate('jwt')
@get('/me', {response: Me})
async me(
  @inject(SecurityBindings.USER) user: UserProfile,  // ← slot 0, fine
): Promise<z.infer<typeof Me>> { ... }
```

The input bundle is built by `buildInputBundle` in `rest.server.ts`, which
validates each declared slot and assembles only the keys present in `RouteSchemas`.

## Response Validation and Status Codes

When `response:` is set, the decorator constrains the method's TypeScript return
type to `z.infer<typeof response>` (or `Promise<...>`). At runtime the return
value is validated via `schema.safeParse(result)`. Mismatches are **logged** (not
thrown) for REST — the response is still sent:

```ts
@post('/echo', {body: EchoIn, response: EchoOut})
async echo(input: {body: z.infer<typeof EchoIn>}): Promise<z.infer<typeof EchoOut>> {
  return {echoed: input.body.text, at: new Date().toISOString()};
}
```

`status:` overrides the default `200`. Status `204` causes `sendResult` to call
`res.end()` and return an empty body:

```ts
@del('/{id}', {path: ItemId, status: 204})
async remove(input: {path: z.infer<typeof ItemId>}): Promise<void> {}
```

Document additional status codes without altering runtime behavior via `responses:`:

```ts
@post('/', {
  body: NewItem,
  response: Item,
  status: 201,
  responses: {409: {description: 'Already exists'}},
})
async create(input: {body: z.infer<typeof NewItem>}) { ... }
```

## URL Placeholders and Header Keys

**URL placeholders must match the `path:` schema's keys.** This is enforced at
`app.start()` when `RestServer` mounts controllers — a mismatch throws with the
controller name, method name, and verb in the error:

```ts
// OK: {name} in the path ↔ `name` key in HelloPath
@get('/hello/{name}', {path: HelloPath})
async hello(input: {path: z.infer<typeof HelloPath>}) { ... }

// THROWS at start: URL has {id} but schema has `itemId`
@get('/{id}', {path: z.object({itemId: z.string()})})
async find(input: {path: {itemId: string}}) { ... }

// THROWS at start: path schema declared but no placeholders in URL
@get('/list', {path: z.object({page: z.number()})})
async list(input: {path: {page: number}}) { ... }
```

**Header schemas use lowercase keys.** Express normalizes incoming header names
to lowercase; the framework also normalizes before validation, so
`z.object({'x-request-id': z.string()})` matches regardless of how the client
sent the header:

```ts
const TraceHeaders = z.object({'x-trace-id': z.string().optional()});

@get('/traced', {headers: TraceHeaders, response: Greeting})
async traced(input: {headers: z.infer<typeof TraceHeaders>}) {
  console.log(input.headers['x-trace-id']);
  return {greeting: 'traced'};
}
```

## Request Pipeline

The fixed pipeline in `RestServer.dispatch` (see `packages/rest/src/rest.server.ts`):

```
HTTP request
  → CORS / Express middleware chain
  → Route match  (no match → 404)
  → Zod validate body / path / query / headers
      body invalid → 422 + ZodError.issues
      path/query/headers invalid → 400 + ZodError.issues
  → Authentication (@authenticate strategy)
      failure → 401
  → Authorization (@authorize voters)
      denial  → 403
  → resolveInjectedArguments (weave @inject bindings into slots 1+)
  → controller method (slot 0 = validated input bundle)
  → Zod validate response (log on mismatch, don't throw)
  → sendResult (JSON; 204 → empty body)
```

Validation errors carry a `details` array of `{path, message}` objects derived
from `ZodError.issues` via `zodIssuesToDetails`. Each request gets its own
child `Context` (`request-<timestamp>`) so request-scoped bindings (user
profile, client application) are isolated and garbage-collected after the
response is sent.

## OpenAPI 3.1 Emission

At spec-assembly time, every Zod schema stored in the route registry is
converted via Zod v4's native `z.toJSONSchema({target: 'draft-2020-12'})`.
OpenAPI 3.1's default dialect is JSON Schema 2020-12, so this is a direct
mapping — no adapter, no `x-ts-type` inlining.

The spec is assembled lazily at each `GET /openapi.json` request (or when
`restServer.getApiSpec()` is called directly), so it always reflects the
currently-bound controllers. OAS enhancers (bound with the
`OAS_ENHANCER_EXTENSION_POINT` tag) run post-assembly to inject `info`,
security schemes, or other cross-cutting spec fields.

```ts
import {assembleOpenApiSpec, zodToOpenApiSchema} from '@agentback/openapi';

// Get the raw spec for a list of controller classes (used internally):
const spec = assembleOpenApiSpec([ItemController], overrides);

// Convert a single Zod schema to a SchemaObject:
const schema = zodToOpenApiSchema(Item);
// → {type: 'object', properties: {id: {type: 'string', format: 'uuid'}, ...}}
```

The spec endpoint path and any field overrides are configured in
`RestServerConfig.openApiSpec`:

```ts
new RestApplication({
  rest: {
    port: 3000,
    openApiSpec: {
      path: '/openapi.json', // default
      overrides: {info: {title: 'My API', version: '1.0.0'}},
    },
  },
});
```

## Swagger UI Explorer

`@agentback/rest-explorer` mounts Swagger UI 5.x at `/explorer` against
the live `/openapi.json`. Call `installExplorer` after registering controllers,
before `app.start()`:

```ts
import {RestApplication} from '@agentback/rest';
import {installExplorer} from '@agentback/rest-explorer';

const app = new RestApplication();
app.restController(ItemController);

await installExplorer(app, {
  path: '/explorer', // default
  specUrl: '/openapi.json', // default
  title: 'My API',
});

await app.start();
// Swagger UI → http://localhost:3000/explorer/
```

For a bare `RestServer` (not a `RestApplication`):

```ts
import {mountExplorer} from '@agentback/rest-explorer';
const server = await app.get('servers.RestServer');
mountExplorer(server, {path: '/docs'});
```

## Explorers and the unified console

Beyond Swagger, several read-only UIs mount on a running app (call before
`app.start()`):

```ts
import {installContextExplorer} from '@agentback/context-explorer';
import {installSchemaExplorer} from '@agentback/schema-explorer';
import {installConsole} from '@agentback/console';

await installContextExplorer(app); // DI container browser     → /context-explorer/
await installSchemaExplorer(app); // schema/entity provenance  → /schema-explorer/
await installConsole(app, {unsafeAllowUnauthenticated: true}); // all panels → /console
```

- **schema-explorer** indexes the app _by Zod schema_ instead of by route/tool:
  each entity is a node with provenance edges to every REST route, MCP tool, and
  Drizzle table that uses it (joined by object identity), plus an ERD-style field
  view. Give a schema a stable name + table origin with
  `bindSchema(app, 'User', User, {table})` from `@agentback/openapi`, or the
  `register{Insert,Select,Update}Schema` helpers in `@agentback/drizzle/zod`.
  Unregistered schemas still appear (discovered from the routes/tools using them).
- **console** composes context-explorer, schema-explorer, rest-explorer, and
  mcp-inspector behind one shell at `/console`; it requires an explicit auth
  posture (`auth` middleware, or `unsafeAllowUnauthenticated: true` for local dev).

## Server port and host

`RestApplication` resolves its listen port/host from three sources, highest
precedence first: explicit `rest` config → `PORT`/`HOST` env vars → the defaults
(`3000` / `127.0.0.1`).

```ts
new RestApplication({rest: {port: 8080}}); // explicit always wins over $PORT
new RestApplication(); // binds $PORT if set (Cloud Run / Heroku), else 3000
```

Env only fills a field you leave unset, so explicit config is never clobbered; a
malformed `PORT` warns and falls back, and `PORT=0` is honored (ephemeral).

## CORS and Middleware

**CORS** is enabled via `RestServerConfig.cors`. Pass `true` for permissive
defaults (the `cors` package's defaults) or a `CorsOptions` object for
fine-grained control. CORS runs as the first Express middleware, before the
LoopBack middleware chain:

```ts
new RestApplication({rest: {cors: true}});

// Fine-grained:
new RestApplication({
  rest: {
    cors: {origin: 'https://app.example.com', credentials: true},
  },
});
```

**Application middleware** runs between the CORS layer and the route handlers.
It can short-circuit responses (rate limiting, CORS preflights, health probes):

```ts
import helmet from 'helmet';

// Express middleware factory (called once at startup):
app.expressMiddleware(helmet);

// Raw LoopBack-style middleware (receives a MiddlewareContext):
app.middleware((ctx, next) => {
  ctx.response.setHeader('X-Request-Id', crypto.randomUUID());
  return next();
});
```

Both APIs are provided by `MiddlewareMixin` (applied to `RestApplication`). The
middleware chain runs through `toExpressMiddleware(this.context)` inside
`RestServer.start()`, so middleware registered at any point before `start()` is
included.

## Subclassing RestServer

`RestServer.dispatch`, `makeHandler`, `sendResult`, and `sendError` are all
`protected`. Subclass to customize the pipeline without rewriting it:

```ts
import {RestServer} from '@agentback/rest';
import type {Request, Response} from 'express';

class MyServer extends RestServer {
  // Wrap every success response in an envelope
  protected override sendResult(
    res: Response,
    result: unknown,
    status: number,
  ): void {
    if (status === 204) return res.end();
    res.status(status).json({ok: true, data: result});
  }

  // Custom error shape
  protected override sendError(
    req: Request,
    res: Response,
    err: unknown,
  ): void {
    const status = (err as {statusCode?: number}).statusCode ?? 500;
    res.status(status).json({ok: false, message: (err as Error).message});
  }
}
```

Bind the subclass instead of the default server:

```ts
app.server(MyServer);
```

Override `dispatch` for cross-cutting concerns that need access to the full
request lifecycle (audit logging, distributed tracing, transaction boundaries):

```ts
protected override async dispatch(req, res, ctor, methodName, schemas) {
  const span = tracer.startSpan(`${ctor.name}.${methodName}`);
  try {
    const result = await super.dispatch(req, res, ctor, methodName, schemas);
    span.end();
    return result;
  } catch (err) {
    span.recordException(err as Error);
    span.end();
    throw err;
  }
}
```

## End-to-End Example

Schema module (shared with clients — no codegen, no drift):

```ts
// schemas.ts
import {z} from 'zod';

export const HelloPath = z.object({name: z.string().min(1).max(64)});
export const Greeting = z.object({greeting: z.string()});

export const EchoIn = z.object({text: z.string().min(1).max(280)});
export const EchoOut = z.object({echoed: z.string(), at: z.string()});
```

Controller and application wiring:

```ts
// index.ts
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {installExplorer} from '@agentback/rest-explorer';
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

const app = new RestApplication({rest: {port: 3000, cors: true}});
app.restController(GreetingController);
await installExplorer(app, {title: 'My API'});
await app.start();
// GET  /greet/hello/Alice  → {"greeting":"Hello, Alice!"}
// POST /greet/echo         → {"echoed":"...","at":"..."}
// GET  /openapi.json       → OpenAPI 3.1.1 spec
// GET  /explorer/          → Swagger UI
```

## Key Rules Recap

1. **Schemas live on the decorator, not in separate annotations.** No `@param`,
   `@requestBody`, or `@response` decorators exist.

2. **Slot 0 = validated input bundle** `{body, path, query, headers}` (only
   declared keys) when any input schema is set. Slot 0 is unconstrained when no
   schemas are set.

3. **`@inject` at slot 1+ when any input schema is declared.** `@inject` at
   slot 0 with a schema throws at decoration time, naming class+method+verb.

4. **`response:` constrains return type and validates at runtime** (logged on
   mismatch for REST, not thrown). `status:` overrides the default `200`;
   `status: 204` returns an empty body.

5. **URL placeholders must match `path:` schema keys exactly.** Checked at
   `app.start()` — mismatches throw naming the controller, method, and verb.

6. **Header schemas use lowercase keys.** Incoming headers are normalized before
   validation; `z.object({'x-request-id': z.string()})` works regardless of
   client casing.

7. **No sequences.** `RestServer.dispatch` is fixed. Extend via middleware
   (`app.middleware()` / `app.expressMiddleware()`) or by subclassing
   `RestServer` and overriding `dispatch`, `makeHandler`, `sendResult`, or
   `sendError`.
