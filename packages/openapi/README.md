# @agentback/openapi

> Zod-first HTTP verb decorators and OpenAPI 3.1.1 spec assembly — no per-parameter decorators, no separate schema registration step.

Zod schemas placed directly on verb decorators are the single source of truth. At decoration time the
schemas are stored in a side registry (`routeRegistry`); at spec-assembly time they are converted to
OpenAPI 3.1.1 via Zod v4's native `z.toJSONSchema({target: 'draft-2020-12'})`. No separate
`@param`/`@requestBody`/`@response` decorators, no `x-ts-type` inlining, no codegen.

## What it provides

**Verb decorators** (method-level)

- `get(path, options?)` / `post` / `put` / `patch` / `del` — shorthand HTTP verb decorators
- `operation(verb, path, options?)` — generic form for any verb (e.g. `head`, `options`)

**Class decorator**

- `api(spec)` — set `basePath` and spec-level metadata (`tags`, `description`, …) on a controller class

**Route options** (`RouteOptions`)

- `body?` — `ZodType`; validated body exposed as `input.body`
- `path?` — `ZodObject`; URL placeholder values as `input.path` (keys must match `{placeholders}`)
- `query?` — `ZodObject`; query string values as `input.query`
- `headers?` — `ZodObject`; lowercase header keys as `input.headers`
- `response?` — `ZodType`; drives the return-type constraint and the `200` response schema
- `responses?` — `Record<number, {schema?, description?}>` — additional documented status codes
- `status?` — override the success status code (default `200`; `204` returns an empty body)
- `description?`, `summary?`, `tags?` — OpenAPI operation metadata

**Types**

- `RouteInput<O>` — inferred input bundle `{body, path, query, headers}` (only declared keys)

**Spec assembly**

- `assembleOpenApiSpec(controllers)` — produce an `OpenApiSpec` from a list of controller classes
- `getControllerSpec(ctor)` — read the `ControllerSpec` (paths, basePath, components) for one class

**Zod bridge utilities**

- `zodToOpenApiSchema(schema)` — `ZodType → SchemaObject | ReferenceObject` via JSON Schema 2020-12
- `registerRouteSchemas(target, method, schemas)` / `lookupRouteSchemas(target, method)` — side registry read/write
- `attachZodSchema(target, schema)` / `getZodSchema(target)` / `isZodSchema(value)` — schema attachment helpers

**Enhancers** — `OASEnhancer` interface + `OAS_ENHANCER_EXTENSION_POINT` for plugging in post-assembly transformations.

## Usage

```ts
import {z} from 'zod';
import {api, get, post, del} from '@agentback/openapi';

const ItemId = z.object({id: z.string().uuid()});
const NewItem = z.object({
  name: z.string().min(1),
  qty: z.number().int().min(0),
});
const Item = NewItem.extend({id: z.string().uuid()});

@api({basePath: '/items', tags: ['items']})
class ItemController {
  @get('/', {response: z.array(Item)})
  async list(): Promise<z.infer<typeof Item>[]> {
    return [];
  }

  @post('/', {body: NewItem, response: Item, status: 201})
  async create(input: {
    body: z.infer<typeof NewItem>;
  }): Promise<z.infer<typeof Item>> {
    return {id: crypto.randomUUID(), ...input.body};
  }

  @get('/{id}', {path: ItemId, response: Item})
  async find(input: {
    path: z.infer<typeof ItemId>;
  }): Promise<z.infer<typeof Item>> {
    return {id: input.path.id, name: 'example', qty: 1};
  }

  @del('/{id}', {path: ItemId, status: 204})
  async remove(input: {path: z.infer<typeof ItemId>}): Promise<void> {}
}
```

**Slot-0 rule**: when any of `body`/`path`/`query`/`headers` is declared the validated bundle is
injected at slot 0. `@inject(...)` must go at slot 1+; placing it at slot 0 throws at decoration time
with the class+method+verb named in the message.

**Header schemas use lowercase keys** — `z.object({'x-request-id': z.string()})` — incoming headers
are normalized before validation.

## Layering

Depends on: `@agentback/context`, `@agentback/core`, `@agentback/metadata`, `zod ^4`,
`openapi3-ts`, `lodash-es`. Consumed by `@agentback/rest` (route mounting + spec serving) and
`@agentback/rest-explorer` (Swagger UI). Has no dependency on `@agentback/rest` — the
decorator and spec-assembly layers are cleanly separated from the HTTP transport.
