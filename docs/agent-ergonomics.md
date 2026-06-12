# Design: Boundary Coherence for AI-Agent-Led Development

**Status:** Draft, captures findings from the May 2026 redesign of `@agentback/{rest, mcp, openapi}`.
**Audience:** Future contributors (human or AI) deciding what to add or change in this framework, and downstream users evaluating whether to adopt it for AI-led codebases.
**Last revised:** 2026-05-21.

## TL;DR

The framework's defensible value for large-scale AI-led TypeScript development is not any single feature (DI, Zod, OpenAPI emission, MCP support). It is the property that **every boundary in the stack is the same artifact, viewed differently**. A single Zod schema simultaneously is: a runtime validator, an `z.infer`-derived TS type, an OpenAPI parameter/body/response, an MCP tool input/output, and a Swagger/Inspector-rendered doc.

That artifact-coherence property is what gives AI agents — whose dominant failure mode is producing plausibly-typed code that diverges from the runtime contract — three orthogonal, localized failure signals (TS error at decoration, startup throw, behavioral test fail) instead of one ambiguous one (something is wrong, somewhere). The framework's design decisions are best evaluated by whether they preserve this property.

## The thesis

Modern Node/TS API frameworks fall on a spectrum:

|                           | Code↔runtime        | Type↔runtime              | Service↔service                        | Tool↔LLM                                       | Human↔docs                 |
| ------------------------- | ------------------- | ------------------------- | -------------------------------------- | ---------------------------------------------- | -------------------------- |
| **Express, raw**          | `req.body` is `any` | Hand-maintained types     | Hand-written OpenAPI                   | Hand-written tool defs                         | Hand-written README        |
| **tRPC**                  | Zod validation      | `z.infer`                 | TS-only (no language-agnostic export)  | Custom adapter                                 | Hand-written               |
| **NestJS + DI**           | class-validator     | Decorators on classes     | OpenAPI emission via `@nestjs/swagger` | Custom adapter                                 | Swagger UI                 |
| **FastAPI (Python)**      | Pydantic            | Type hints _are_ Pydantic | OpenAPI auto-emitted                   | Custom adapter                                 | Swagger UI                 |
| **AgentBack (this)** | Zod                 | `z.infer` derived         | OpenAPI 3.1 auto-emitted from same Zod | MCP `inputSchema`/`outputSchema` from same Zod | Swagger UI + MCP Inspector |

The further down the table, the fewer distinct artifacts a contributor (or an AI agent) has to keep coherent. FastAPI's adoption among AI engineers is not coincidental: a Pydantic model is the validator, the type, and the OpenAPI parameter all at once. TypeScript has historically not had a clean version of this story; the framework's bet is that decorators carrying Zod schemas can supply it.

## Three pillars and what each contributes

### 1. DI + extension points (`@agentback/{context, core}`)

What it gives an agent:

- **Named slots to fill.** Adding an auth strategy, a config provider, a health check, an MCP tool, or a REST controller is a recipe: implement a known shape, bind it under a known key, tag it. The agent has no architectural choices to invent.
- **Local reasoning.** Each DI-bound class is self-contained — declared dependencies in the constructor or as properties, no implicit imports from a hidden global registry.
- **Composability without modifying core code.** New capability = new binding. The framework discovers it by tag. The agent does not have to find and edit a router config or a switch statement.
- **Testability without mocking ceremony.** `app.bind('clock').to(stub)` swaps a dependency for tests; no Jest module-mock incantation needed.

What it costs an agent:

- **Indirection.** `@inject('clock')` does not click through to the binding. Agents whose primary navigation is grep have to follow the binding key by hand. Typed binding keys (`BindingKey.create<Clock>('clock')`) help but don't eliminate this.
- **Decorator metaprogramming has known TS weak spots.** `TypedPropertyDescriptor` invariance, the legacy-vs-stage-3 decorator transition, `emitDecoratorMetadata`'s crude type information — all surfaces where agent-generated code goes subtly wrong.
- **Boilerplate amortizes only at scale.** For a 5-route service the framework is overhead the agent has to maintain. The crossover is somewhere around "multiple teams, plugin surface, AI tool exposure, per-tenant config."

### 2. Zod (`@agentback/openapi`)

What it gives an agent:

- **One artifact, four uses.** Schema → validator, type (`z.infer`), JSON Schema (`z.toJSONSchema`), OpenAPI/MCP contract — all derived from the same Zod expression. Agents are dramatically better at maintaining one source than at synchronizing several.
- **Structured, machine-readable errors.** `ZodError.issues[]` with `path`, `code`, `message` is exactly what agent-written error handlers want to consume.
- **Alignment with the AI ecosystem's center of gravity.** OpenAI structured outputs, Anthropic tool_use, Vercel AI SDK's `tool()`, and MCP all consume JSON Schema. Zod produces JSON Schema. The loop closes.
- **Composability.** `Base.extend({...})`, `.pick()`, `.omit()`, `.merge()` map to how agents think about iterative refinement.

What it costs an agent:

- **Inference is opaque under transforms.** `z.preprocess(s => s.trim(), z.string())` produces an `infer` that agents sometimes can't predict, leading to spurious `as` casts.
- **Library churn.** Zod 3 → 4 introduced real breaking changes that agents trained on v3 idioms regenerate. We hit this directly in this codebase (`z.string().uuid()` deprecation, `ZodObject<ZodRawShape>` shape changes).

### 3. OpenAPI 3.1 emission (`@agentback/openapi`, mounted by `@agentback/rest`)

What it gives an agent:

- **Self-describing surfaces.** A service that publishes `/openapi.json` lets downstream agents introspect what routes exist, what they expect, what they return. This is the same loop MCP closes for tools (`tools/list` → `inputSchema`); OpenAPI closes it for HTTP.
- **Drift elimination by construction.** Hand-maintained spec docs lag behind code. Auto-emission from decorator metadata cannot drift; the spec changes when the code changes.
- **Language-agnostic boundary.** tRPC, ts-rest, Effect.Schema are TS-native. OpenAPI lets a Python service, a Rust service, or a different agent runtime consume your API without speaking TS.
- **Documentation and machine contract are the same JSON.** No "is the docs accurate?" question.

What it costs an agent:

- **Large specs blow context windows.** A 200-route service produces a JSON document that no single LLM call holds. Mitigations (Swagger UI per-tag rendering, `?path=` filters) are partial. We do not currently address this.
- **Zod → OpenAPI is good but not perfect.** Complex discriminated unions, recursive types, and refinements sometimes emit JSON Schema that's technically correct but ugly to read — and ugly schemas confuse agents back when they consume them.

## The "boundary coherence" insight

The genuinely novel value of the stack is not in any pillar individually; it is in the fact that **the same Zod schema, declared once on the verb decorator (or `@tool`), services every boundary the agent might cross**:

| Boundary                   | What the same schema becomes                     |
| -------------------------- | ------------------------------------------------ |
| Code → runtime             | Validator (`safeParse`)                          |
| Method signature → handler | TS type (`z.infer`)                              |
| Service → service          | OpenAPI `parameter` / `requestBody` / `response` |
| Tool → LLM                 | MCP `inputSchema` / `outputSchema`               |
| Human → docs               | Swagger UI / MCP Inspector rendering             |

An agent reading or writing a controller has _one place to look_ to understand all five. Compared to a typical Node/TS stack — TS types in `types.ts`, validators in `validators.ts`, OpenAPI in `swagger.yaml`, AI tools in `tool-defs.ts`, docs in `README.md` — that's a substantial reduction in surface area the agent has to keep coherent.

This is exactly the Python-FastAPI promise transplanted to TypeScript by way of decorators that carry Zod schemas. The framework's design decisions (the rewrites described below) preserve this property at compile time, so agents catch boundary mismatches at the decoration line instead of at the second integration test.

## Why this is more aligned with spec/type-driven than test-driven development

The decorator _is_ the spec:

```ts
@post('/items', {
  body: CreateItem,
  response: Item,
  responses: {404: {schema: NotFound}, 422: {schema: ValidationFailure}},
  status: 201,
})
async create(input: {body: z.infer<typeof CreateItem>}) {
  throw new Error('TODO');
}
```

By the time this compiles, you have committed to:

- the input contract (Zod schema → runtime validation + TS type),
- the URL contract (`/items`, status 201),
- the success-shape contract (`response: Item`),
- the documented error contracts (`404`, `422`),
- the OpenAPI document at `/openapi.json`,
- the MCP-style introspectable signature (for inspector tools).

The implementation is the only thing missing. That is spec-first in the literal sense: the contract lands before the behavior, the contract is enforced by the compiler, and the spec emission happens for free.

The implementation cannot drift from the spec:

- **TS** enforces that `input.body` matches `z.infer<typeof CreateItem>`. A wrong parameter shape errors at the `@post` line.
- **Runtime** validates the return against `response:` (logged on mismatch); the URL-placeholder guard at `app.start()` catches path-shape drift.
- **The OpenAPI doc** is emitted, not maintained — so it cannot drift from the schema.

This is closer to **type-driven development** (Idris-style: the type carries enough information that the implementation is constrained) than to either pure spec-driven or pure TDD. The framework does not replace TDD; tests verify _behavior_ (does the route persist the item, does auth reject wrong users, does pagination round-trip), while the contract layer absorbs the "is the shape right?" class of bugs.

The full cycle that emerges:

1. **Spec layer**: write Zod schemas + decorator. One artifact.
2. **Type check**: TS verifies the implementation matches the contract.
3. **Behavior tests**: assert valid inputs produce correct outputs.
4. **Refactor**: change the schema; type errors guide the edits; tests verify nothing semantic regressed.

Stages 1 and 2 are spec-driven; stage 3 is TDD; stage 4 leverages the type system to localize the work.

## The agent ergonomics angle

Agents iterate best when failure signals are **precise** and **localized**. A spec-first framework gives the agent three distinct failure classes:

| Signal        | What it points at                                                                | Where it fires  |
| ------------- | -------------------------------------------------------------------------------- | --------------- |
| TS error      | Implementation type drifted from schema                                          | Decoration line |
| Startup throw | URL ↔ path-schema mismatch, slot-0 `@inject` collision, missing required binding | `app.start()`   |
| Test failure  | Behavioral bug                                                                   | Test runner     |

The agent gets three orthogonal red signals, each pointing at a different category of mistake. The schema-as-spec layer absorbs the "shape mistake" class entirely, so when a test fails the agent knows the bug is behavioral, not structural. That's a meaningful reduction in the search space the agent has to navigate.

This also means agent-led development can be **schema-first, test-second**:

1. Agent writes Zod schemas + decorators (the spec).
2. Agent runs `pnpm build`; the type system confirms the spec compiles.
3. Agent writes tests against the declared contract.
4. Agent writes the implementation. TS errors guide the structural work; tests guide the behavioral work.

Compared to an Express + raw-Zod stack where the agent has to keep the route handler, the validator, the type, and the OpenAPI doc in sync by hand: fewer sources of truth, less drift, fewer cycles.

## Implementation evidence: what the framework does to preserve the property

The recent rewrites of `@agentback/{rest, mcp, openapi}` are all in service of preserving boundary coherence at compile time.

### Slot-0 input bundle on verb and tool decorators

```ts
@get('/hello/{name}', {path: HelloPath, response: Greeting})
async hello(input: {path: z.infer<typeof HelloPath>}) { ... }

@tool('forecast', {input: ForecastIn, output: ForecastOut})
async forecast(input: z.infer<typeof ForecastIn>) { ... }
```

A `TypedPropertyDescriptor` constraint on slot 0 forces the method's first parameter to satisfy `z.infer` of the declared schemas. A mismatch errors at the decoration line with the property difference surfaced precisely. Without this, the implementation can silently drift from the spec and the agent only finds out at request time.

Replaced: per-parameter `@param.path` / `@requestBody` / `@response` / `@arg` decorators that required the agent to keep three declarations in sync (decorator, parameter type, schema).

### Compile-time output enforcement on `@tool`

```ts
@tool('forecast', {input: ForecastIn, output: ForecastOut})
async forecast(input: z.infer<typeof ForecastIn>) {
  return {wrong: 'shape'};
  //     ^^^^^^^^^^^^^^^ TS error at @tool line: not assignable to z.infer<ForecastOut>
}
```

The decorator's generic R constrains the method's return type. Runtime validation belt-and-suspenders the same check at invocation. The MCP SDK is given `outputSchema` so structured-content clients consume the typed payload directly.

### URL placeholder ↔ path schema check at `app.start()`

```ts
@get('/users/{id}', {path: z.object({userId: z.string()}), response: User})
//          ^^                       ^^^^^^
```

Throws at startup with `Bad.getOne @get('/users/{id}'): path placeholders don't match the path schema — URL has {id} but schema doesn't; schema has [userId] but URL doesn't.` Without this, the route silently 422s on every request — exactly the class of mistake agents make often and notice late.

### Centralized dispatch with subclassable hooks

`RestServer.dispatch` / `sendResult` / `sendError` are protected and overridable. The standard LB4 sequence pattern (`findRoute → parseParams → invoke → send → reject` as a five-action DI pipeline) is gone, but the most common use cases (response envelopes, custom error contracts, request-scoped tracing) are covered by single-method overrides:

```ts
class EnvelopeRestServer extends RestServer {
  protected override sendResult(res, result, status) {
    res.status(status).json({ok: true, data: result});
  }
}
```

This is the explicit escape hatch for the "I want to wrap responses uniformly" class of need that previously required reaching for the full sequence pattern.

### Middleware chain wired into RestServer

`RestApplication` extends `MiddlewareMixin(Application)`. `RestServer.start()` mounts `toExpressMiddleware(this.context)` before route handlers. Users register cross-cutting concerns via `app.middleware(fn)` / `app.expressMiddleware(factory)`; middleware runs through the framework's chain and can short-circuit (CORS preflights, rate limit rejections, probes) before reaching the dispatcher.

### CORS as a typed config knob

```ts
app.configure('servers.RestServer').to({
  cors: {origin: 'https://example.com', credentials: true},
});
```

One configuration field, a thin wrapper around the `cors` package, mounted globally in the server constructor. The previous "CORS is a non-goal" framing was misleading — it was unwritten sugar, not an architectural omission.

## Honest limits

The thesis is not a free lunch. Where the framework's bet is weaker:

### Decorator typing is the binding constraint

Every advance in the framework's agent-friendliness has been a fight against TS's classic decorator type system. The `TypedPropertyDescriptor` invariance issue alone forced two different workarounds (constrained generic R for input, conditional `RouteDescriptor<O, R>` for slot-0). The framework cannot get materially more typesafe than the underlying TS decorator implementation allows. Migration to stage-3 decorators may eventually loosen this; we do not currently plan it.

### OpenAPI from Zod is correct but not always pretty

`z.toJSONSchema` produces draft-2020-12 output that satisfies OpenAPI 3.1's dialect. For simple object schemas the output is clean. For Zod features like discriminated unions with branded predicates, recursive types, and complex refinements, the emitted JSON Schema is technically valid but unwieldy. Downstream agents consuming these specs can struggle. We do not currently post-process for readability.

### Boundary coherence requires _adoption_ of the pattern

A user who escapes via `restServer.expressApp.use(...)` for routing, or writes a custom validator in the route handler body, exits the boundary-coherence property for that route. The framework cannot enforce its own use; it can only make the in-pattern path the easy one. Documented escape hatches (CORS option, subclassable dispatch) are the explicit support for "I need to step outside the pattern, here is the supported way." Ad-hoc bypass via the express app is supported but unblessed.

### The crossover threshold matters

For genuinely small services (a handful of routes, no plugin surface, no multi-team consumption, no AI tool exposure), the framework is overhead the agent has to maintain. The break-even point is "your app is big enough that boundary coherence costs more to maintain by hand than it costs in framework conventions." Below that line, `Hono + zValidator` is simpler and the agent does fine. Above that line, the framework's bet pays back.

### Not OpenAPI-first in the canonical sense

A pure spec-first workflow writes `openapi.yaml` standalone, then generates code stubs from it. We do the inverse: write decorators, emit OpenAPI. This means:

- If you have an existing OpenAPI 3.1 contract you want to honor, the framework does not scaffold controllers for you. You translate by hand.
- Schemas live in TypeScript. Non-TS teams can read the emitted OpenAPI but cannot author against the source-of-truth Zod schemas directly. The canonical cross-team artifact is the OpenAPI export, not the Zod schema.

For most codebases this is the right trade. For codebases where the API spec is the source of truth and many teams build against it, the inversion would matter.

## Design decisions this thesis informs

Whenever the framework gains a feature or absorbs an external pattern, the question to ask is: **does this preserve or degrade boundary coherence?**

Examples of decisions the thesis has informed (or would inform):

| Decision                                                                  | Preserves coherence?                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Replacing `@param`/`@requestBody`/`@response` with verb-decorator options | Yes (one source of truth)                                                       |
| Adding `@arg` per-parameter decoration to MCP `@tool`                     | No (two declarations) — _reverted_                                              |
| Adding `output:` to `@tool` with typed return constraint                  | Yes (return type derives from schema)                                           |
| Adding LB4-style sequences/actions with DI-bound pipeline steps           | No (introduces new abstraction layer that doesn't share artifacts) — _kept out_ |
| Adding CORS via `RestServerConfig.cors`                                   | Neutral (orthogonal to the schema artifact) — _adopted_                         |
| Adding subclassable `dispatch` / `sendResult` / `sendError`               | Yes (preserves spec, lets users override behavior) — _adopted_                  |
| Adding a separate `openapi.yaml` spec authoring step                      | No (introduces a second source of truth) — _kept out_                           |

The thesis is not "every new feature must touch the Zod schema." It is "no new feature should create a second source of truth that the agent has to keep in sync with the Zod schema."

## Open questions

1. **Tool/route filtering for large specs.** A 200-tool MCP server or 200-route REST service produces a manifest no single LLM call can hold. Should the inspector/openapi expose `?include=...` or `?tag=...` filters so agents can fetch scoped subsets?
2. **JSON Schema readability.** Zod's emitted schemas are sometimes ugly. Worth post-processing for cleaner downstream consumption?
3. **OpenAPI-first inversion.** If demand emerges from cross-team consumers, would we add `lb4-from-openapi` codegen? At what point does maintaining two source-of-truth artifacts become acceptable?
4. **MCP HTTP/SSE transport.** Stdio works today. HTTP is the obvious next addition once the SDK transport is wired in. Should the same `RouteOptions` shape extend to MCP HTTP routes for symmetry?
5. **Per-tenant or per-version OpenAPI emission.** Multi-tenant SaaS deployments may want versioned or tenant-scoped specs. Does the framework grow that, or do users build it on top via the existing enhancer extension point?

## References within this codebase

- Schema-on-decorator pattern: `packages/openapi/src/decorators/operation.decorator.ts`, `packages/mcp/src/decorators/tool.decorator.ts`
- Per-route schema registry: `packages/openapi/src/zod-bridge.ts` (`registerRouteSchemas` / `lookupRouteSchemas`)
- OpenAPI assembly from `RouteOptions`: `packages/openapi/src/controller-spec.ts`
- Subclassable REST dispatch: `packages/rest/src/rest.server.ts` (`makeHandler` / `dispatch` / `sendResult` / `sendError`)
- MCP tool dispatch with `@inject` weaving: `packages/mcp/src/mcp.server.ts` (`dispatchTool`)
- Middleware chain wiring: `packages/rest/src/rest.application.ts` (`MiddlewareMixin(Application)`), `rest.server.ts` (`toExpressMiddleware(this.context)`)
- Type-enforcement tests (deliberate mismatches): see commit messages on `feat(mcp)!: object-style tool input`, `feat(rest, mcp)!: method-level Zod schemas`.

## Glossary

- **Boundary coherence**: the property that every API boundary (runtime, type, doc, AI tool) is derivable from the same source artifact (a Zod schema), so the artifact cannot disagree with itself.
- **Slot-0 rule**: the method's first parameter (slot 0) is reserved for the validated input bundle when the verb/tool decorator declares any input schemas. `@inject` parameters live at slot 1+. When no schemas are declared, slot 0 is unconstrained and can carry `@inject` directly.
- **Spec-first / type-driven development**: a workflow where the contract (Zod schema + decorator options) is declared before the implementation, and the type system enforces the implementation conforms.
- **Localized failure signal**: an error message that names the file, line, and conceptual category of the mistake (e.g., "TS error at the `@post` line because `input.body.title` is missing"). Agents iterate dramatically faster on localized signals than on diffuse ones ("a test is failing somewhere").
