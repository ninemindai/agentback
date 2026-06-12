# Proposal P0-3: Escaping Legacy Decorators (reflect-metadata exit path)

**Status:** Phase 1 implemented (2026-06-10); phases 2–3 tracked.
**Packages touched:** `context` (phase 1), `metadata` (phase 2), everything (phase 3).

## Motivation

The LB4 port runs on `experimentalDecorators` + `emitDecoratorMetadata` +
`reflect-metadata`. This is the exact configuration the Node ecosystem is
moving away from — it blocks Node's native type-stripping
(`--experimental-strip-types`), requires transpiler plugins for esbuild/SWC,
and is publicly cited as a reason not to start new NestJS projects. NestJS
_cannot_ migrate: TC39 Stage 3 decorators have no parameter decorators and
emit no `design:paramtypes`, and Nest's DI is built on both.

AgentBack is unusually well positioned to escape:

- The schema-on-decorator rewrite already **eliminated parameter decorators
  from the request path** (the slot-0 input bundle replaced
  `@param`/`@requestBody`/`@arg`).
- `@inject` always takes an **explicit binding key** — `design:paramtypes`
  type inference is _not_ load-bearing for resolution
  (`packages/context/src/inject.ts:127-213`; `design:*` reads live only in
  `MetadataInspector.getDesignTypeForMethod`, used for diagnostics).

The remaining hard dependency is `@inject` _as a parameter decorator_ on
constructors and on handler-method slots 1+.

## Design

### Phase 1 (now): injection without parameter decorators

Add a static-property injection form, resolvable with zero decorator support:

```ts
import {injectSpec} from '@agentback/context';

class OrderService {
  static inject = {
    params: [DB_KEY, injectSpec.tag('payment.rails')] as const,
    properties: {clock: CLOCK_KEY},
  } satisfies InjectStatics;

  constructor(
    private db: Db,
    private rails: PaymentRail[],
  ) {}
  clock!: Clock;
}
```

- `params` entries are `BindingSelector | InjectSpec`. **Review note:** the
  existing `inject.tag(...)`/`inject.getter(...)` helpers return _decorator
  closures_ that write Reflect metadata when applied — they cannot be reused
  as values. Phase 1 therefore adds a small parallel descriptor API,
  `injectSpec.{tag,getter,setter,binding}`, returning plain
  `{bindingSelector, metadata, resolve?}` objects (the same `Injection`
  fields the decorators produce). A plain `BindingKey`/string is shorthand
  for `injectSpec.key(...)`. This is modestly more code than "reuse the
  helpers" but keeps the static form genuinely metadata-free.
- Resolution: `describeInjectedArguments(target, '')` (constructor case) and
  `describeInjectedProperties(target)` in `packages/context/src/inject.ts:570-715`
  learn to read `ctor.inject` **when present**, taking precedence over
  decorator metadata (a class uses one style; mixing throws with a clear
  message). Sparse entries (`undefined` in `params`) keep supporting
  non-injected leading args (the slot-0 bundle).
- **Inheritance rule:** only an **own** `static inject` property applies
  (`Object.hasOwn`), mirroring the decorator path's
  `shouldSkipBaseConstructorInjection` — a subclass with its own constructor
  must declare its own `params`; silently inheriting the parent's arity is a
  footgun.
- Handler methods: REST/MCP slot-1+ injection gains the same escape via
  `static injectMethods = {createOrder: [undefined, USER_KEY]}`.
- This phase ships **alongside** the existing decorators — no breaking
  change, purely additive. It is immediately useful for consumers who write
  apps with `tsc --erasableSyntaxOnly` or Node type-stripping, while the
  framework's own packages continue building as today.

### Phase 2: dual-signature class/method decorators

All framework decorators (`@injectable`, `@api`, verb decorators, `@tool`,
`@authorize`, …) are class or method decorators — shapes TC39 _does_ support.
Phase 2 makes `MetadataAccessor`/`DecoratorFactory`
(`packages/metadata/src`) dual-mode:

- Detect invocation shape at runtime: legacy `(target, key, descriptor)` vs
  TC39 `(value, context)`.
- Storage: legacy path keeps `Reflect` metadata; TC39 path writes to
  `context.metadata` (`Symbol.metadata`), with `MetadataInspector` reading
  from whichever store is populated.
- `@inject` as a _property_ decorator also exists in TC39 (accessor/field
  decorators); only the _parameter_ position has no TC39 equivalent — covered
  by Phase 1's static form.

### Phase 3: flip the default

Templates/examples/docs use TC39 decorators + `static inject`; the
`reflect-metadata` import becomes optional (only needed for legacy-mode
consumers); CI adds a matrix leg running an example under
`node --experimental-strip-types`. Marketing line unlocked: _no transpiler
config, no reflect-metadata_.

## Why not "just keep experimentalDecorators"?

Cost compounds: every new package adds reflect-metadata surface area, and the
migration is monotonically more expensive. Phase 1 is small (one resolver
seam), establishes the API users will keep, and de-risks phases 2–3 by
proving resolution works decorator-free.

## Implementation plan (Phase 1 — in scope for this round)

1. `context`: `InjectStatics` type; teach `describeInjectedArguments` /
   `describeInjectedProperties` to consult `ctor.inject` /
   `ctor.injectMethods`; precedence + mixing guard; ensure
   `instantiateClass` and `resolveInjectedArguments` need no changes (they
   already consume the describe\* output).
2. Unit tests: constructor injection via statics, property injection via
   statics, method slot-1+ injection via statics with slot-0 bundle, mixing
   guard, getter/tag helper forms.
3. Acceptance: a controller class written with **zero decorators on
   parameters** (verb decorators still on methods) served by `RestServer`.
4. Docs: new concepts section "Injection without parameter decorators".

Phases 2–3 are separate follow-ups; this proposal fixes their direction so
Phase 1's API doesn't churn.

## Out of scope

- Dropping legacy decorator support (not before 1.0).
- Auto-wiring by parameter type (deliberately never — explicit keys are the
  design, and they're what makes this migration possible at all).
