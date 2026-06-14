# Context Explorer → DI Wiring Explorer — Design

**Date:** 2026-06-14
**Status:** Approved design, independently reviewed against the codebase
(findings A, B, 6, 7, 8 incorporated); ready for implementation planning.
**Package:** `@agentback/context-explorer`
**Supersedes (extends):** `2026-05-29-context-explorer-design.md` (the original
three-view explorer). This is a redesign of the same package, not a new one.

## Problem

The context explorer today exposes a DI container as three views — **Browse**
(filterable list + detail), **Graph** (injection dependency graph), **Raw**
(the `inspect()` JSON) — over three endpoints (`/bindings`, `/inspect`,
`/graph`). It answers "what bindings exist and what injects what," but it does
not surface the **architecture LoopBack encodes in tag conventions**:

- which bindings are **extension points** and which **extensions** contribute to
  them (`extensionPoint` / `extensionFor` tag values);
- **lifecycle observers** and their boot **group** (`lifeCycleObserver`,
  `lifeCycleObserverGroup`);
- the **config pattern** — config bindings and the binding each configures
  (`configurationFor` tag value);
- the **context hierarchy** (App → Server → Request) as a tree rather than a
  flattened list;
- the **application / components** in play;
- **controllers** and their REST routes, and **MCP servers** and their tools.

The blocker is concrete: `flattenInspection` keeps only tag **keys**
(`Object.keys(tags)`) and discards tag **values**. The values are exactly the
wiring — extension-point names, config targets, lifecycle groups. The raw
`inspect()` data already carries them (`toJSON()` serializes `tags: this.tagMap`,
the full key→value map); the API throws them away.

## Goals

Surface the container **as wired architecture**, indexed by facet:

1. Visualize binding **scopes / types** (color-coded, filterable).
2. **Tags** as first-class key=value data for grouping and search.
3. **Extension point → extensions** wiring.
4. **Lifecycle observers**, grouped by boot group.
5. **Application / Component** view.
6. **Context hierarchy** as a tree.
7. **Config pattern** (config binding ↔ configured binding).
8. **Controllers** and their REST routes.
9. **MCP servers** and their tools.

## Non-goals

- **No write/mutation.** Read-only, as today.
- **No deep schema rendering for routes/tools.** `/explorer` (Swagger) and
  `/mcp-inspector` already do that; `schema-explorer` indexes by schema. The
  explorer shows a **compact** route/tool list per binding and **links out** to
  those tools. It does not duplicate Swagger or the schema graph.
- **No binding→component provenance edges.** Core does not record which
  component contributed a binding (`mountComponent` adds bindings untagged), so
  the explorer must not fabricate that edge. (See Decisions.)
- **No exact cross-group lifecycle boot ordering.** The resolved order lives in
  the `LifeCycleObserverRegistry` and depends on configured group order;
  surfacing it faithfully would require resolving the registry. Out of scope —
  the explorer shows declared grouping only (see Decisions). **Expectation-setting
  (review finding 7):** the `lifeCycleObserverGroup` tag is set *only* by the
  `@lifeCycleObserver(group)` decorator. The common registration paths
  (`app.lifeCycleObserver()`, component mounting, servers, every
  `.apply(asLifeCycleObserver)`) set only the `lifeCycleObserver` tag, **not** a
  group. So in a typical app most observers have `lifeCycleGroup === undefined`
  and land in a single "default" bucket — the Lifecycle facet is a faithful view
  of *declared* groups, which will often be sparse, not a rich grouping. This is
  acceptable: the facet's job is to enumerate observers and surface whatever
  grouping was declared, not to reconstruct boot order.
- **No new top-level npm dependency.** Reuse React Flow (already a dep for the
  graph view) and `console-theme`.

## The safety invariant (constraint that shapes every decision)

**The explorer never resolves a binding's value.** Resolving could instantiate a
provider or read a secret (e.g. a JWT-secret constant binding), so the explorer
works purely from binding **metadata**: `inspect()` output, `tagMap`, and
decorator metadata read off `valueConstructor` **without instantiating the
class**. Reading `MetadataInspector` method metadata off a class constructor is
safe (no instantiation); resolving a binding's value is not.

**One deliberate, narrow exception (approved):** the model builder may resolve
**only** `CoreBindings.APPLICATION_METADATA`. That binding is a plain
`package.json`-derived object (`name`, `version`, …) set via `.to(metadata)` — a
constant, never a secret — used to render an application identity card (item 5).
No other binding is ever resolved. The exception is implemented as an explicit,
single-key `getSync(APPLICATION_METADATA, {optional: true})` guarded in a
`try/catch`, not as a general "resolve constants" path.

## Architecture decisions locked during brainstorming

### One consolidated model endpoint, split by data *source* not by UI surface

The nine features are almost all **different views of the same dataset**. The
flat list, the nested tree, and the dependency graph are three projections of
one binding set; extension wiring, config edges, lifecycle grouping, hierarchy,
and the kind facets are all derivations of binding tags + the parent chain.
Splitting one-endpoint-per-feature would return the *same* binding node from
multiple endpoints and force the client to re-join by key.

Two facts make a single model endpoint not just tidier but **correct**:

- After the `2026-06-14` refactor (commit `8d923d6`, "unify controller discovery
  on the core `controller` tag"), a **dual `@api` + `@mcpServer` class registered
  via `restController()`** (the additive alias) or merged through a component's
  `controllers`/`services` arrays is **ONE binding** carrying both the
  `controller` tag and `extensionFor(MCP_SERVERS)` membership — one node that is
  simultaneously a controller (with routes) and an MCP server (with tools).
  **Caveat (review finding A):** this single-binding outcome is *conditional*.
  The commit message is explicit that explicit `app.controller(C)` **plus**
  `app.service(C)` for the same class keep **two separate bindings** (no magic) —
  and CLAUDE.md still documents that two-call pattern. So the same dual class can
  appear as **one binding** (routes+tools) *or* **two bindings** sharing a
  `valueConstructor`. The model must therefore **join dual identity by
  `valueConstructor` name, not by binding key**: the UI groups the controller and
  mcpServer facets of a class together when they share a source class, whether
  that is one binding or two. Either way, separate `/controllers` and
  `/mcp-servers` endpoints would force the client to re-join across payloads;
  one model keeps the join server-side.
- A single payload is an **atomic snapshot** — separate `/bindings` + `/graph`
  fetches can disagree if anything changes between them.

This also matches the framework's own thesis (single source of truth / boundary
coherence — `docs/agent-ergonomics.md`): every view becomes a **pure function of
one model**.

The only genuine reason to split — lazy-loading the (slightly more expensive)
metadata reads for routes/tools — is YAGNI for an in-process dev tool inspecting
one app.

**Resulting API (two endpoints, by data source):**

- **`GET /context-explorer/api/model`** — the consolidated, derived model
  (below). The new home for everything the UI computes from.
- **`GET /context-explorer/api/inspect`** — the **raw** `inspect()` passthrough,
  kept for the Raw view as unreshaped ground truth (query flags
  `includeInjections` / `includeParent` retained).

`GET /bindings` and `GET /graph` are **removed** — they were redundant
projections now derived client-side from `model`. (This is a breaking API change;
acceptable for an alpha package and consistent with the dogfooding story.)

### Server computes `kinds`, `routes`, `tools` authoritatively

The model is built server-side, so the **server** computes each node's `kinds`
set and attaches `routes`/`tools` using the **same filters REST/MCP/
schema-explorer use** — the client never guesses kinds from array-valued tags.
Discovery patterns are mirrored verbatim from `schema-explorer/src/inventory.ts`
(updated in the same refactor):

- **Controllers:** `ctx.findByTag(CoreTags.CONTROLLER)` → `b.valueConstructor` →
  `getControllerSpec(ctor)` (from `@agentback/openapi`) → `spec.basePath` +
  `spec.paths` (verb/path/operationId). `getControllerSpec` is wrapped in
  `try/catch` (a routeless controller yields empty paths — a safe no-op).
- **MCP servers:** `ctx.find(extensionFilter(MCP_SERVERS))` →
  `b.valueConstructor` → `MetadataInspector.getAllMethodMetadata<ToolMetadata>(
  MCPKeys.TOOL, ctor.prototype)` → tool `name` / `title` / `description`.

Neither read instantiates a class, so the safety invariant holds.

## API: the model payload

A real `@api`/`@get` controller (`ContextExplorerController`), registered via
`app.controller(...)`, with Zod response schemas (dogfooding the framework's own
routing). Injects `CoreBindings.APPLICATION_INSTANCE` to introspect the full
registry and parent chain.

```ts
// GET /context-explorer/api/model
ContextModel = {
  app: {                       // item 5 — from APPLICATION_METADATA (the one
    name?: string;             //   permitted resolve), optional/best-effort
    version?: string;
  };
  contexts: Array<{            // item 6 — the parent chain
    name: string;              //   e.g. "Application", "RestServer", "request"
    parent?: string;           //   parent context name, undefined at the root
  }>;
  bindings: Array<{
    key: string;
    context: string;           // owning context name (for the Context facet/tree)
    scope: string;             // Singleton | Transient | Context | Request | ...
    type?: string;             // Class | Provider | Constant | Alias | ...
    source?: string;           // valueConstructor / providerConstructor / alias
    isLocked?: boolean;
    tags: Array<{name: string; value: string | boolean}>;  // P0 ENABLER (see note)
    kinds: string[];           // server-computed set (see Kind taxonomy below)
    dependsOn: string[];       // direct-key injection edges only (see note)
    extensionPoint?: string;   // item 3 — if this binding IS a point
    extensionFor?: string[];   // item 3 — point name(s) this binding extends
    configurationFor?: string; // item 7 — target key this binding configures
    lifeCycleGroup?: string;   // item 4 — boot group (may be undefined)
    routes?: Array<{verb: string; path: string; status?: number}>; // item 8
    tools?: Array<{name: string; title?: string; description?: string}>; // item 9
  }>;
};
```

### Kind taxonomy (the `kinds` set — a binding may have several)

Computed server-side from authoritative filters/tags:

| kind | detected by |
| --- | --- |
| `controller` | `findByTag(CoreTags.CONTROLLER)` membership |
| `mcpServer` | `find(extensionFilter(MCP_SERVERS))` membership |
| `component` | `CoreTags.COMPONENT` type tag / `components.*` namespace |
| `lifeCycleObserver` | `CoreTags.LIFE_CYCLE_OBSERVER` tag |
| `extensionPoint` | `CoreTags.EXTENSION_POINT` tag present |
| `extension` | `CoreTags.EXTENSION_FOR` tag present |
| `config` | `ContextTags.CONFIGURATION_FOR` tag present |
| `server` | `servers.*` namespace / server tag |

A binding with none of these has an empty `kinds` set ("plain"). A dual
REST+MCP class registered as one binding has `['controller', 'mcpServer', ...]`;
registered as two bindings, each binding carries one of the kinds and the client
joins them by `valueConstructor` name (finding A).

### Data-shape notes (review findings B & 6)

- **`tags` value normalization (finding B).** `tagMap` values are
  `string | string[] | true`. In particular `extensionFor` is a bare **string**
  for a single point and a **`string[]`** for multiple
  (`extension-point.ts`). The builder must therefore expand an array-valued tag
  into multiple `{name, value}` entries (or flatten consistently) rather than
  `Object.entries(tagMap)` naively, and `extensionFor?: string[]` must coerce the
  single-string case to a one-element array.
- **`dependsOn` covers direct-key injections only (finding 6).**
  `inspect({includeInjections:true})` emits `bindingKey` only for direct key
  injections; `@extensions()`/tag-filter injections emit `bindingTagPattern` and
  filter-function injections emit `bindingFilter` — **no resolvable key**. So
  `dependsOn` (and the Graph view) silently omit extension-point→extensions and
  other filter-based wiring. That wiring is instead surfaced via the
  **tag-derived** extension-point↔extensions section (below), which does not
  depend on injection metadata. This split is intentional, not a gap.

### Derivations (client-side selectors over `model`)

- **Extension point → extensions (3):** group bindings whose `extensionFor`
  includes point `P` under each binding with `extensionPoint === P` (and surface
  orphan `extensionFor` values with no matching point binding).
- **Lifecycle (4):** group `lifeCycleObserver` bindings by `lifeCycleGroup`
  (undefined → a "default" bucket), ordered by group name. **Labeled as declared
  grouping, not resolved boot order** (see Non-goals).
- **Config (7):** for each binding with `configurationFor === K`, draw a
  "Configures `K`" edge; the inverse appears on `K`'s detail as "Configured by".
- **Hierarchy (6):** build the context tree from `contexts[]`; bucket bindings by
  `context`.
- **App/Component (5):** the App identity card from `model.app` + a section/facet
  for `component` bindings. No provenance edges.

## Client UI

A **three-pane facet shell** replacing today's two-pane Browse, with **Graph**,
**Hierarchy**, and **Raw** as alternate top-level views. All panes/views are pure
functions of `model` (Raw uses `/inspect`). No router, no global store — App owns
state, mirroring the current architecture. `apiBase` continues to be supplied by
the standalone shell or the console, so the panel stays reusable under any mount.

### Layout

```
┌ header: title · counts · [Explore][Graph][Hierarchy][Raw] ─────────────┐
├ facet nav ──┬ results ───────────────────┬ detail ─────────────────────┤
│ Kind        │ filter: ____________        │ <key>                       │
│  controller │ ┌────────────────────────┐ │ scope · type · context      │
│  mcpServer  │ │ key            [scope]  │ │ tags: name=value …          │
│  component… │ │   [type] tag=val …      │ │ Depends on / Depended on by │
│ Scope       │ └────────────────────────┘ │ Configures / Configured by  │
│  singleton… │  …                          │ Extension point ↔ extensions│
│ Type        │                             │ Routes (controller) ↗       │
│ Tag         │                             │ Tools  (mcp server) ↗       │
│ Ext. point  │                             │                             │
│ Lifecycle   │                             │                             │
│ Context     │                             │                             │
└─────────────┴─────────────────────────────┴─────────────────────────────┘
```

- **Facet nav (left):** collapsible facet groups, each value with a live count.
  Multi-select **within** a facet = OR; **across** facets = AND. Facets: Kind,
  Scope, Type, Tag (name → values), Extension point, Lifecycle group, Context.
- **Results (center):** free-text key filter + binding rows with **color-coded**
  scope and type badges (legend in the facet nav) and tag=value chips.
- **Detail (right):** all metadata; **Depends on / Depended on by**;
  **Configures / Configured by**; **extension point ↔ extensions**; for a
  controller a **Routes** list, for an MCP server a **Tools** list — a dual
  binding shows **both** — each linking out to `/explorer` and `/mcp-inspector`.
- **Graph view:** existing React Flow injection graph, extended with
  **color-by-scope** and an optional **extension-point overlay**.
- **Hierarchy view:** the context tree from `contexts[]` with per-context binding
  counts; selecting a context filters results to it.
- **Raw view:** unchanged — the `/inspect` JSON.

### Color tokens

Scope and type colors are added to `console-theme` (or as explorer-local tokens
if theme changes are undesirable) so the unified console stays visually
coherent. A small legend renders in the facet nav.

## Files affected (indicative, finalized in the plan)

- `packages/context-explorer/src/index.ts` — replace `flattenInspection` /
  `extractGraph` with a `buildModel(ctx)` builder; controller exposes `/model`
  (+ retains `/inspect`); remove `/bindings` and `/graph`; new Zod schemas;
  `contextConsoleFeature()` updated to the new `apiBase` shape.
- `packages/context-explorer/src/client/api.ts` — `fetchModel()` + types;
  remove `fetchBindings`/`fetchGraph`.
- `packages/context-explorer/src/client/App.tsx` — three-pane facet shell + view
  switch (Explore/Graph/Hierarchy/Raw); selectors over `model`.
- New client components: `FacetNav`, `ResultsList` (evolve `BindingList`),
  `BindingDetail` (extend with config/extension/routes/tools sections),
  `HierarchyView`; `GraphView` gains color-by-scope.
- `packages/context-explorer/src/client/lib/` — pure selector functions
  (facets, extension grouping, config edges, hierarchy tree) — unit-testable.
- `packages/console` — the SPA bundles context-explorer's client *source*
  (`console/src/client/pages.ts` imports the TSX), so client fetch changes are
  picked up automatically; no console client wiring to change. **But
  `packages/console/src/__tests__/integration/console.integration.ts` asserts
  `GET /context-explorer/api/bindings` returns 200/401 (review finding 8) — those
  assertions must be repointed to `/model` when `/bindings` is removed.**
- READMEs: `context-explorer/README.md` (new views + `/model` API).

## Testing

`vitest` runs against built `dist/` (repo rule — `pnpm build` before
`pnpm test`).

- **`explorer.integration.ts` (extend):** boot a small app exercising every kind
  — a `@api` controller, a `@mcpServer` tool class, a **dual `@api`+`@mcpServer`**
  class, a component, a lifecycle observer (incl. one via
  `@lifeCycleObserver(group)` so a non-default group exists), an extension point +
  extension (incl. a multi-point `extensionFor` to exercise the array case,
  finding B), a `.configure()` config binding. Assert:
  - `/model` returns tag **values** (not just names), with array tag values
    expanded correctly;
  - `kinds` is correct;
  - **dual binding — both registration paths (finding A):** register one dual
    class via `restController()` and assert it is **one** node carrying both
    `controller`+`mcpServer` and both `routes`+`tools`; register a second dual
    class via `app.controller()` + `app.service()` and assert it surfaces as
    **two** nodes sharing a `valueConstructor`, joinable by source class;
  - extension `extensionFor` resolves to the point's `extensionPoint`;
  - `configurationFor` edge present;
  - `contexts[]` parent chain present;
  - `app.name`/`version` populated from `APPLICATION_METADATA`;
  - **no binding is resolved** (e.g. a provider with a throwing/​side-effecting
    constructor stays untouched; a secret constant value never appears in the
    payload) — except the single permitted `APPLICATION_METADATA` read;
  - `/bindings` and `/graph` are gone (404 / not registered).
- **`packages/console` integration (finding 8):** repoint the
  `/context-explorer/api/bindings` assertions in `console.integration.ts` to
  `/model` (200 ungated, 401 when gated). Required for the console suite to pass.
- **Pure selector unit tests** for facet counting, extension grouping (incl.
  array `extensionFor`), config edges, hierarchy-tree construction, and the
  by-`valueConstructor` dual-binding join.

## Phasing (one plan, staged commits)

- **P0 — enabler + model endpoint.** `buildModel` with normalized tag values
  (incl. array `extensionFor`), `kinds`, `dependsOn` (direct-key only),
  `contexts`, and `app` (the `APPLICATION_METADATA` read); `/model` live;
  `/bindings`+`/graph` removed; client switched to `fetchModel`; existing views
  kept working. **Repoint `console.integration.ts` to `/model`** (finding 8).
  Integration test for the model shape + no-resolve.
- **P1 — facet shell + scope/type + tags (1, 2).** Three-pane layout, FacetNav,
  color tokens/legend, tag=value chips, group/multi-select facets.
- **P2 — extension points + lifecycle + config + hierarchy + app/component
  (3, 4, 5, 6, 7).** Detail-pane wiring sections, Hierarchy view, app identity
  card, selector libs + their unit tests.
- **P3 — controllers + MCP servers (8, 9).** Server-side `routes`/`tools` reads
  (mirroring schema-explorer), detail-pane Routes/Tools lists with link-outs,
  dual-binding handling with the **by-`valueConstructor` join** (one-binding and
  two-binding paths, finding A); integration coverage for both dual paths.

## Open questions

None blocking. The two constraints that could surprise a reader — no
binding→component provenance, and declared-not-resolved lifecycle order — are
recorded as Non-goals with their rationale.
