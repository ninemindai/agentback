# Research note: Cordis and "Spatiotemporal Composability"

**Status:** Research note, August 2026. Not a proposal to adopt anything; a
study of an adjacent framework whose thesis overlaps ours on the agent-harness
frontier, with concrete takeaways at the end.
**Sources:** [cordiverse/cordis](https://github.com/cordiverse/cordis) (v4.0.0-rc,
core read in full — ~1,850 lines), the preprint
[_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper)
(Shi, Zhang, Cui; Peking University + DeepSeek-AI; draft of 2026-08-13, 81 pp.),
and the loader/HMR packages in the same monorepo.

## What Cordis is

Cordis is the plugin runtime extracted from [Koishi](https://koishi.chat) (a
chatbot framework with 4,000+ community plugins), rebranded as a
"meta-framework of spatiotemporal composability." Its entire core is one
abstraction applied ruthlessly: **every registration is a revertible effect,
and every dependency is a reactive subscription.** The 2026 preprint — notable
for DeepSeek-AI co-authorship and for naming "self-evolving agent harnesses"
as the motivating workload — gives the design a formal semantics and metatheory.

The paper identifies two orthogonal dimensions of dynamic composition:

- **Temporal composability** — removing a component completely and safely
  reverts its side effects on the shared environment.
- **Spatial composability** — components declare dependencies that the runtime
  resolves _reactively_ as providers appear, disappear, or change identity.

Classical effect systems (how a computation _modifies_ its environment) and
coeffect systems (what it _requires_ from it) formalize exactly these two
directions, but only statically. The paper's move is to lift both to runtime
mechanisms: _revertible effects_ (every context transformation carries an
inverse the runtime tracks and composes) and _reactive coeffects_ (every
context change is classified against each component's dependency
specification as activating, deactivating, or neutral).

## How the implementation works

Everything below is from reading the source (`packages/core/src/`, ~1,850
lines total).

- **`Context` is a Proxy, and services are properties on it** (`context.ts`,
  `reflect.ts`). There are no binding keys: a service registered via
  `ctx.provide('database', impl)` is read as `ctx.database`. The Proxy `get`
  handler walks the fiber parent chain to resolve it — and **throws if the
  accessing plugin did not declare `database` in its `inject` list**. Declared
  dependencies are the only visible ones; coeffects are enforced at property
  access. Types come from TypeScript declaration merging on
  `interface Context`, not from typed keys.
- **`Fiber` is a plugin instance's lifecycle cell** (`fiber.ts`), with a real
  state machine (`PENDING → LOADING → ACTIVE → FAILED → DISPOSED →
UNLOADING`). The reactivity trick is the **epoch string**: a fiber's epoch
  concatenates the UIDs of the fibers currently providing its dependencies.
  Re-provide any dependency and every dependent's epoch changes, which
  automatically unloads and reloads it. Hot-swapping a database plugin
  restarts everything that injects `database`, with no orchestration code.
- **`effect()` is the temporal half** (`fiber.ts`): every side effect must
  return its own disposer (or a sync/async iterable of disposers — generator
  functions `yield` one per step). Disposal runs in reverse order.
  `provide` is itself an effect, so removing a plugin removes its service,
  which cascades epoch changes to dependents.
- **The traceability proxy is the load-bearing trick** (`utils.ts`,
  `getTraceable`/`createTraceable`). Every service value carries a tracker;
  reading `ctx.database` returns not the instance but a proxy that rebinds the
  service's `this.ctx` to the _caller's_ context. When a service method
  internally registers a listener, the disposer lands in the **caller's**
  fiber. Attribution of side effects to the right lifecycle owner is automatic
  and transitive (method returns are re-wrapped too). This is what makes "an
  inexperienced author obtains ordered cleanup without writing an uninstall
  path" true — and it is also the runtime cost: every property access on
  every service allocates a proxy.
- **Config validation is Standard Schema** (`fiber.ts`, `resolveConfig` via
  `StandardSchemaV1`), so Zod plugs in unchanged.
- **The loader is a two-way reconciler** (`packages/loader`). `Entry.update()`
  deep-diffs new options against old and touches only what changed — and it
  writes _backwards_: a runtime config change or a plugin self-dispose is
  persisted into the config file (`internal/update` hook). Config file and
  running process are kept bidirectionally consistent, closer to a Kubernetes
  controller than to a config reader.
- **HMR is webpack's accept/decline bubbling without the manual API, plus
  transactions** (`packages/hmr`). It reads Node's internal module graph
  (`--expose-internals`), propagates a change up the dependent chain to the
  plugin entry files (the atomic reload units), then does a transactional
  reload: back up both the ESM `loadCache` and CJS `require.cache`, clear,
  re-import, and on any failure restore both caches and re-register the old
  plugins. The system never enters a half-reloaded state.

## The metatheory (why the paper matters)

The paper's calculus has ten rules (orchestration + fiber lifecycle) and
proves the properties you would actually want from a hot-swappable system
(§4.4):

- **Recovery exactness (Thm 61):** running a fiber's accumulated inverse
  yields the state as if that fiber had _never begun_ — even with other
  fibers interleaving arbitrarily — given pairwise independence of effects.
- **Ordering (Thm 63):** a fiber activates only when its dependencies are
  provided, and a provider outlives its consumers.
- **Resolution coherence (Thm 64):** a loading transition runs against
  exactly one dependency resolution; if the world shifts mid-load, the
  transition is diverted and unloaded, never half-applied against a stale
  view.
- **Progress (Thm 66):** no deadlock, plus a termination bound —
  reconfiguration storms settle.
- **Confluence (§4.4.5):** the headline. _The dynamic history leaves no
  trace_: whatever sequence of loads/unloads/reloads a running system went
  through, it quiesces at exactly the state a from-scratch static assembly
  would produce. This is the incremental-computation consistency guarantee
  ported to component systems — and it is the property an agent-edited
  process actually needs. Without it, long-running hot-reloaded processes
  accumulate drift, which is why everyone falls back to restarts.

The related-work section sharpens the claim: OSGi/iPOJO/VSCode recover via
_hand-written_ deactivation callbacks (a forgotten one leaks silently);
Erlang/DSU migrate state _forward_ through hand-written `code_change`
functions; React's `useEffect` pairs effect with inverse but cannot compose
(top-level only, no async, no iterators). Cordis's position: pair every
_atomic_ effect with an inverse and derive composite inverses _by
composition_, making complete recovery an invariant rather than a duty.

Honest caveats the paper itself owns (§5.3, §6): the Koishi validation is an
existence-and-adoption result, not a controlled comparison, and Koishi runs
Cordis v3 while the paper formalizes v4. The **system boundary** limits
temporal composability: effects that _emit_ beyond the process (a network
send, a paid API call) can only be withheld or compensated, never reverted.
**Dependency cycles** leave both components permanently inactive; the
prescribed fix (factoring into integration components) grows quadratically.
And dependency links are **nominal string keys** — §6.6 concedes versioning
and key collision are open gaps, with npm peer dependencies as the stopgap.

## Relevance to AgentBack

The two frameworks answer different questions and are strong where the other
is silent. AgentBack's thesis is **boundary coherence** (one Zod artifact
projected to every boundary — see
[agent-ergonomics.md](../agent-ergonomics.md)); Cordis's is **lifecycle
coherence** (every mount revertible, every dependency reactive). Both are
aimed at AI-led development, from opposite ends.

| Concern                                         | AgentBack                                                                                                                                                                                                                                                  | Cordis                                                       |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Boundary coherence (schemas → REST/MCP/OpenAPI) | The whole thesis                                                                                                                                                                                                                                           | Absent (Standard Schema for _config_ only)                   |
| Request lifecycle, auth, transports, actors     | First-class                                                                                                                                                                                                                                                | No concept of a request                                      |
| Unmount/revert a mounted capability             | Not a guarantee (`install*` helpers mount irreversibly)                                                                                                                                                                                                    | The whole thesis, with proofs                                |
| Dependency change at runtime                    | Partial: `ContextView`/`ContextObserver` re-resolve tag-scoped collections on bind/unbind (middleware chain, extension points, actors' degradable extensions); constructor injection is fixed, so a provider swap = restart, and unbinding reverts nothing | Reactive re-resolution with effect reversal, HMR, confluence |
| Typed dependency links                          | Binding keys, compile-checked injects                                                                                                                                                                                                                      | Nominal string keys (versioning an admitted open gap)        |

Takeaways, in decreasing order of actionability:

1. **The disposer discipline is stealable at a seam we already have.** Every
   `install*` helper could return (and internally compose) an `uninstall`.
   No fibers, proxies, or reactivity needed — just the invariant that _mount
   functions return their inverse_. That is the cheapest 20% of Cordis, it
   buys the option of hot component swap later, and it is most relevant to
   `@agentback/plugin`. Now drafted as
   [revertible-installs.md](revertible-installs.md), which shipped as the
   substrate; the plugin-seam half — unmount, plus the cheapest _static_ slice
   of the spatial axis (declared `provides`/`inject` for derived mount order
   and pre-import collision detection, with no reactivity) — is drafted as
   [plugin-composability.md](plugin-composability.md).
2. **Restart is our current answer to evolution, and it now has a named
   counterpoint.** The see-and-evolve agent-console direction treats
   evolution as _source edit + process restart_. That is defensible — restart
   is the coarse-grained workaround the paper concedes everyone uses (§1.2.3)
   — but the paper is the strongest articulation yet of what restart costs at
   agent edit-frequency: discarded process-local state, disrupted in-flight
   work, and a faulty self-modification disabling the process needed to
   recover. [agent-ergonomics.md](../agent-ergonomics.md#honest-limits)
   records this as a known limit of our bet.
3. **Their service-broker pattern (§6.2) converges with our ports.** A stable
   broker interface absorbing provider swaps (rolling updates without
   dependent reloads) is functionally what `FileStore`/`JobQueue`/
   `ActorRuntime` already are. We arrived at the same shape without the
   reactivity machinery — which suggests the ports are the right stable
   surface if live adapter swapping ever becomes a requirement.

Non-takeaways, for the record: the ambient-Proxy context (stringly-namespaced
services, no request scope, per-access proxy allocation) trades away exactly
the static guarantees and per-request isolation our stack is built on; and
adopting the fiber/epoch machinery wholesale would be a second framework
inside the framework. The value here is the discipline (effects return their
inverses) and the formal vocabulary, not the runtime.
