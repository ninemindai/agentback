# Proposal P0-3b: TC39 Standard Decorators — Phases 2 & 3

**Status:** Deferred (design saved 2026-06). Not scheduled — the Phase-3 flip
is breaking and belongs on a marked version line; revisit per the
recommendation below (ship Phase 2 first, prototype the Phase-3 slot-0 typing
before committing).
**Builds on:** [p0-3-standard-decorators.md](p0-3-standard-decorators.md) (phase 1
— `static inject` / `injectSpec` — shipped). This doc designs the remaining
two phases in detail.
**Packages touched:** `metadata`, `context` (the machinery); then every
package (the internal migration).

## Why

The framework runs on `experimentalDecorators` + `emitDecoratorMetadata` +
`reflect-metadata`. That configuration is the single thing keeping
AgentBack off Node's native type-stripping (`node
--experimental-strip-types`), off transpiler-plugin-free esbuild/SWC, and on
a decorator dialect TC39 superseded. NestJS **cannot** leave it — its DI is
built on constructor parameter decorators and `design:paramtypes`, neither of
which exists in TC39 Stage 3. AgentBack can, because **phase 1 already
removed parameter decorators from the resolution hot path**: `@inject` takes
an explicit key (never inferred from `design:paramtypes`), and the `static
inject` / `injectSpec` API gives a parameter-decorator-free way to express
every injection. What remains is the machinery and the internal migration.

The end state: _write an AgentBack app with standard decorators, compile
with `experimentalDecorators: false`, run the source under
`node --experimental-strip-types` — no `reflect-metadata`, no transpiler
config._ No other DI-based Node framework can say this.

## The three hard constraints (these shape everything below)

1. **TC39 has no parameter decorators.** `constructor(@inject(K) x)` is not
   expressible. Phase 1's `static inject` is the replacement, and the
   framework's own 56 constructor-injection sites (27 files) must migrate to
   it before the framework can compile under `experimentalDecorators: false`.

2. **`emitDecoratorMetadata` (`design:*` types) does not exist under standard
   decorators.** Audit result: of all `design:*` reads, only **one is
   load-bearing** — `@service()` _without_ an explicit type
   (`packages/core/src/service.ts:81-100`) infers the binding from
   `design:type`. Everything else (`assertTargetType`/`inspectTargetType` in
   `inject.ts`) is **diagnostic only** — it produces nicer error messages and
   is already a no-op when design types are absent (`inject.ts:413-414`). So
   standard mode loses exactly one feature: type-inferred `@service()`, which
   becomes "pass the type explicitly" (`@service(Foo)` / static form).

3. **A single decorator cannot be _typed_ for both modes.** TS infers nothing
   about a decorator from the consumer's tsconfig flags; the decorator's
   declared type in the `.d.ts` is either the legacy shape
   (`(target, key, descriptor) => void`) or the standard shape
   (`(value, context) => …`), and these are mutually unassignable. **There is
   no `.d.ts` that type-checks as a valid decorator under both
   `experimentalDecorators: true` and `false`.** This is the decisive
   finding: "dual-mode" is achievable at _runtime_ but not at the _type_
   level. The framework's public decorator **types** must pick one mode; the
   **runtime** can accept both. We therefore flip the types to standard
   (the future) and keep legacy working at runtime as a migration bridge.

## Design

### Phase 2 — runtime dual-mode metadata machinery (non-breaking)

Make the decorator factories and `MetadataInspector` read/write correctly
whether a decorator is invoked the **legacy** way `(target, member,
descriptorOrIndex)` or the **standard** way `(value, context)` — producing
byte-identical `MetadataMap` shapes and inheritance semantics either way. This
is purely additive: nothing about today's legacy behavior changes.

**Mode detection** (one choke point — the function `DecoratorFactory.create()`
returns):

```
isStandard = args.length === 2
  && typeof args[1] === 'object' && args[1] !== null
  && typeof args[1].kind === 'string'   // 'class'|'method'|'getter'|'setter'|'field'|'accessor'
```

A legacy class decorator is 1-arg; a legacy property decorator is 2-arg with a
string/symbol second arg; a legacy method/parameter decorator is 3-arg. Only a
standard decorator passes a 2nd-arg object carrying `kind`. Robust and cheap.

**A `MetadataStore` seam** unifies the two backends so the merge/inheritance
logic is written once:

```ts
interface MetadataStore {
  getOwn(key: string): unknown; // own-only (clone-on-write trigger)
  get(key: string): unknown; // inherited (prototype chain)
  define(key: string, value: unknown): void;
}
```

- **Legacy backend** (`ReflectStore(target, member?)`) wraps the existing
  `Reflector` calls — `getOwnMetadata` / `getMetadata` / `defineMetadata`.
  Behavior is exactly today's.
- **Standard backend** (`ObjectStore(context.metadata)`) reads/writes the
  per-class metadata object TC39 threads through `context.metadata` (exposed
  after construction as `Class[Symbol.metadata]`). Inheritance is free: a
  subclass's `context.metadata` has the base class's metadata object as its
  **prototype**, so `get(key)` resolves inherited values by prototype lookup
  and `getOwn(key)` is `Object.hasOwn(metadata, key) ? metadata[key] :
undefined`. The existing `mergeWithInherited`/`mergeWithOwn` clone-on-write
  logic transfers unchanged — only the store differs.

`DecoratorFactory.decorate(...)` is refactored to take a `MetadataStore` plus
the `member`/`descriptorOrIndex`. The created decorator builds the right store
from the detected mode and calls the shared logic. The `ClassDecoratorFactory`
/ `MethodDecoratorFactory` / `PropertyDecoratorFactory` map shapes
(`{name: spec}`) are emitted identically by both backends — so **every
consumer (`MetadataInspector`, `getControllerSpec`, `collectAllTools`,
`describeInjectedProperties`, …) is untouched.**

**`MetadataInspector` reads both stores.** Each getter resolves a store for
the target: `Class[Symbol.metadata]` if present (standard), else `Reflector`
(legacy). A class authored in either mode is found. (A class can only be
authored in _one_ mode — `experimentalDecorators` is per-compilation — so
there is never ambiguity for a given class.)

**Parameter & property decorators under standard mode:**

- **Parameter** `@inject`: no standard form exists (no param decorators). In a
  standard-mode codebase the parser rejects parameter decorators outright, so
  there is nothing to handle at runtime — the user writes `static inject`
  instead (phase 1). The legacy `ParameterDecoratorFactory` path stays for
  legacy-mode consumers.
- **Property** `@inject`: gains a standard **field/accessor decorator** form
  that records the property name + injection spec into `context.metadata`
  (the same metadata `describeInjectedProperties` reads). It does **not**
  resolve at decoration time — the container resolves at instantiation, as
  today. `@inject(KEY) accessor db!: Db` is the idiom; a plain field works
  too. (Note the `useDefineForClassFields: false` interaction — see Risks.)

**`reflect-metadata` becomes optional.** Today `packages/metadata/src/reflect.ts:5`
imports it unconditionally as a global polyfill. Standard mode never calls
`Reflect.defineMetadata` (it uses `Symbol.metadata`), so a fully-standard
consumer needs no polyfill. Guard the import: load `reflect-metadata` lazily
the first time the legacy backend is used (or when the host lacks the global),
and add `Symbol.metadata` via `esnext.decorators` lib (or a 3-line
`Symbol.metadata ??= Symbol('Symbol.metadata')` shim) so standard mode runs on
stock Node with zero deps.

**Phase 2 deliverables:** the `MetadataStore` seam + mode detection in
`metadata`; `MetadataInspector` dual-read; `@inject` standard property form in
`context`; optional `reflect-metadata`; a test matrix that exercises a sample
class authored _both_ ways and asserts identical `MetadataInspector` output;
no public type changes yet. **Fully backward compatible.**

### Phase 3 — flip the framework (breaking, pre-1.0)

Phase 2 makes standard-authored classes _work_; Phase 3 makes the framework
_ship as standard_ so consumers get the type story and the framework itself
sheds `reflect-metadata`.

1. **Migrate the framework's 56 parameter-injection sites to `static
inject`.** Mechanical: `constructor(@inject(K) private x: T)` →
   `static inject = {params: [K]}` + a plain `constructor(private x: T)`.
   `@config()` and `@service()` parameters convert to their `injectSpec`
   equivalents. This is the bulk of the work — 27 files, scriptable with
   manual review. The framework's _own_ code becomes the reference example
   for the static form.

2. **Flip public decorator types to standard.** The verb decorators, `@tool`,
   `@authorize`, etc. re-type their returned decorator to the standard
   signature. The compile-time **slot-0-bundle enforcement** (today via
   `TypedPropertyDescriptor`) re-expresses against the standard method
   decorator's `value` type — the boundary-coherence check survives, just on
   the new decorator shape. (This is the one genuinely fiddly typing task;
   prototype it first to confirm the enforcement still bites.)

3. **Drop `emitDecoratorMetadata`; set `experimentalDecorators: false`;** add
   `esnext.decorators` to `lib`. `@service()` requires an explicit type from
   here on (documented migration). The framework source now compiles as
   standard decorators.

4. **Flip templates, examples, and the `create-agentback` scaffolds** to
   standard decorators + `static inject`. Add a CI leg that runs an example's
   source under `node --experimental-strip-types` to prove the no-transpiler
   claim, and one that builds it with esbuild _without_ a decorator-metadata
   plugin.

5. **Keep the legacy runtime path** (Phase 2's `ReflectStore`) so a consumer
   who can't flip immediately can still author legacy decorators against the
   standard-typed framework by setting `experimentalDecorators: true` in their
   own tsconfig and tolerating the type-shape mismatch via a thin
   legacy-typings entrypoint (`@agentback/<pkg>/legacy`) — optional, only
   if demand exists.

## Sequencing & recommendation

- **Ship Phase 2 now.** It is contained (two packages), non-breaking, fully
  testable (author-both-ways matrix), and is the prerequisite that de-risks
  Phase 3. It also immediately benefits JS consumers and anyone hand-writing
  `context.metadata`.
- **Gate Phase 3 on an explicit decision.** It is a breaking change (every
  consumer flips `experimentalDecorators`, `@service()` loses inference) and a
  large internal migration. It is the right end state and the headline
  differentiator, but it belongs on a marked version line (e.g. the `0.2`
  pre-alpha bump) with its own changelog and migration guide — not slipped in.
  Recommendation: commit to it, schedule it as its own focused effort right
  after Phase 2 lands, and prototype the Phase-3 step 2 typing first to
  confirm the slot-0 enforcement survives before committing the migration.

## Risks

- **Typing the slot-0 enforcement on standard decorators** (Phase 3 step 2) is
  unproven until prototyped — it's the gating risk for the whole flip. Do it
  first.
- **`useDefineForClassFields: false` + standard field decorators**: TS couples
  field-decorator semantics to this flag. The `@inject` property form must be
  tested under the framework's actual setting; `accessor` fields side-step the
  ambiguity if plain fields misbehave.
- **`Symbol.metadata` availability**: TS 6.0 supports it but it's not in the
  current `lib`. Add `esnext.decorators` or the one-line global shim; verify
  on Node 22.13 and 24.
- **Mixed-mode in one app**: impossible by construction (`experimentalDecorators`
  is per-compilation), so no class is ever ambiguous — but a monorepo with two
  tsconfigs could have legacy and standard packages side by side; the dual-read
  inspector handles that.

## Out of scope

- Removing the legacy runtime path entirely (keep it through 1.0 as the bridge).
- Auto-migrating user code (ship a codemod note, not a tool, unless demand).
- `design:paramtypes`-based `@service()` inference (deliberately dropped in
  standard mode; explicit types replace it).
