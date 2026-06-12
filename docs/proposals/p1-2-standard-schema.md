# Proposal P1-2: Standard Schema Compatibility

**Status:** Implemented (2026-06-10) — REST/OpenAPI/client; MCP tools followed via the SDK low-level registration path (follow-up, same day).
**Packages touched:** `openapi`, `mcp`, `client` (typing + parse paths only).

## Motivation

Standard Schema (the `~standard` interface co-authored by Zod, Valibot,
ArkType) won: Hono, Elysia, oRPC, tRPC, the AI SDK consume it, and NestJS v12
makes it the headline of its validation overhaul. Staying Zod-_only_ converts
"we use Valibot/ArkType" from a preference into an adoption blocker.
Staying Zod-_first_ (docs, examples, drizzle-zod chain) is unchanged.

The constraint that makes this non-trivial: AgentBack doesn't just
_validate_ — it **emits JSON Schema** (OpenAPI parameters/bodies/responses,
MCP tool input/output). Standard Schema standardizes validation + type
inference, but not JSON Schema emission.

## Design

### Two internal seams

All decorator schema handling funnels through two new helpers in `openapi`
(re-used by `mcp` and `client`):

```ts
// 1. validation — works for ANY Standard Schema
standardParse(schema: SchemaLike, value: unknown):
  {success: true; data: T} | {success: false; issues: StandardIssue[]}
// Zod fast-path: schema.safeParse. Otherwise schema['~standard'].validate
// (async results rejected with a clear error — request validation is sync).

// 2. emission — capability-based
schemaToJSONSchema(schema: SchemaLike): JSONSchema
// Resolution order:
//   a. Zod          → z.toJSONSchema (today's path, unchanged)
//   b. ArkType      → schema.toJsonSchema() (native capability sniff)
//   c. registered converter for schema['~standard'].vendor
//      via registerJSONSchemaConverter('valibot', v => toJsonSchema(v))
//   d. throw at app.start() naming the route/tool and the vendor
```

(d) is the important behavior: a schema that can validate but not describe
itself **fails at startup**, not by silently emitting `{}` into
`/openapi.json` — boundary coherence forbids undescribed boundaries.

### Decorator typing

`RouteOptions`/`ToolOptions` fields widen from `ZodType` to
`SchemaLike = ZodType | StandardSchemaV1`. Inference goes through one
conditional alias:

```ts
type InferIn<S> = S extends ZodType
  ? z.infer<S>
  : S extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<S>
    : never;
```

`RouteInput`/`SuccessReturn`/`RouteDescriptor`
(`packages/openapi/src/decorators/operation.decorator.ts:53-82`) and the
client's `RouteInput`/`RouteOutput` switch to `InferIn`. Object-shaped slots
(`path`, `query`, `headers`) additionally require key enumerability for the
placeholder check — for non-Zod schemas the path-placeholder validation falls
back to emission-derived property names (from `schemaToJSONSchema(...).properties`)
at `app.start()`.

### Scope discipline

- `@standard-schema/spec` is a **type-only** dev dependency (the spec is
  designed for this — the `~standard` property is sniffed structurally).
- No converter packages are bundled; `registerJSONSchemaConverter` is the
  extension point and the README shows the two-line Valibot registration.
- Error mapping: `StandardIssue[]` → the existing `ValidationIssue` shape in
  `rest/src/errors.ts` (path + message; `code/expected/received` populated
  only for Zod).

## Sequencing

Lands **after** P0-2 (typed streaming): both rewrite the
`RouteInput`/`SuccessReturn` typing seam, and this proposal's threading
checklist explicitly includes `streamOf` (validate stream items via
`standardParse`, emit `x-itemSchema` via `schemaToJSONSchema`).

## Implementation plan

1. `openapi`: `SchemaLike`, `standardParse`, `schemaToJSONSchema` + converter
   registry; thread through `zod-bridge`, `operationFromOptions`, request
   validation in `rest`, **and the `streamOf` paths from P0-2**.
2. `mcp` — **phase-scoped (review-corrected):** the MCP SDK's high-level
   `registerTool` API is Zod-shaped (`registerAllOn` passes
   `meta.input?.shape`, a `ZodRawShape`); non-Zod schemas have no `.shape`
   and cannot be threaded through it. Phase 1 therefore keeps `@tool`
   **Zod-only** and adds a clear `app.start()` error when a non-Zod schema
   is used on a tool ("Standard Schema on MCP tools requires the low-level
   handler path — not yet supported"). Moving tool registration to the
   SDK's low-level `setRequestHandler` path with JSON-Schema-declared tools
   and framework-side validation is a separate follow-up — it is a rewrite
   of tool registration, not a parse-path tweak.
3. `client`: typing + `executeRoute` validation through `standardParse`.
4. Tests: an ArkType route end-to-end (validates + emits), a Valibot route
   with registered converter, startup failure for converter-less vendor,
   typing assertions (expect-type) for `InferIn` across the three libraries.

## Out of scope

- Replacing Zod anywhere in the framework's own packages/examples.
- Async validation support (Standard Schema allows it; HTTP-request
  validation stays sync — async schemas throw with guidance).
- drizzle-zod equivalents for other vendors.
