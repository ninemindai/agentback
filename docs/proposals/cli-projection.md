# Proposal: `@agentback/command` — project `@tool` classes as an operator CLI

> **Naming:** the obvious name `@agentback/cli` is already taken by the **deploy**
> CLI (bin `agentback`/`abc` — `agentback deploy vercel|cloudflare`). This is a
> different thing: a library that turns an app's own `@tool` classes into a
> command-line surface. Working name `@agentback/command` (it projects tools as
> _commands_); alternatives `@agentback/cli-tools`, `@agentback/argv`. Decision
> deferred to the naming open question below; this file keeps a concept path.

**Status:** Exploratory (E-4, 2026-07-06). **Eng-reviewed 2026-07-06** — see the
GSTACK REVIEW REPORT at the bottom; five decisions locked, audience reframed
from agent-first to operator-first after the outside voice. Prompted by
[goke](https://github.com/remorses/goke) ("build CLIs like you'd build an API")
and [incur](https://github.com/wevm/incur) ("CLIs for agents and humans") — two
TypeScript frameworks that arrive at AgentBack's own thesis from the CLI side.

**Relationship to prior art:** the **sixth projection** of the one `@tool`
surface, and a sibling of [`@agentback/agents`](harness.md) (E-3): where
`toHostTools` routes an AI SDK loop through `MCPServer.callTool`, this routes
**argv/stdout** through the identical seam. It is _not_ a new authoring model
(no `.command()` builder to learn — the tool already exists) and _not_ a
deploy/ops CLI (that is `@agentback/cli`).

## Thesis

An AgentBack `@tool` already fans out to five surfaces from one Zod schema set:
a REST route, an MCP tool, an OpenAPI operation, a schema-typed HTTP client, and
(E-3) an AI SDK host-tool. Every one of those is a **networked** surface — it
needs a running server, a transport, usually auth config.

The surface it does **not** have is **argv in, stdout out** — a real terminal
command a **human operator** runs by hand, or drops into a shell script, a
Makefile, a cron line, or a CI step, with no server to boot and no client to
register.

**Who this is for (eng review T1 — reframed after the outside voice).** The
original draft pitched this as agent-first: "an agent in a shell reaches for
argv first." That framing is weak, and the review challenged it honestly — an
AgentBack app **already ships an MCP server over stdio** (`@agentback/mcp`,
default transport). A coding agent registers that with one config line and
calls tools with **typed JSON in**, boot-once, no argv→JSON impedance. For an
agent, the stdio MCP surface is _strictly better_ than a CLI. So the CLI's
primary user is the **human operator/scripter** who wants `my-svc forecast
--city Tokyo` without writing an HTTP call or wiring an MCP client. Agent-mode
(`--format json`) stays a **bonus**, not the headline: handy when a human's
script is itself driven by an agent, never a replacement for stdio MCP.

The honest value, then, is _reach_, not a new agent channel: the same `@tool`
becomes a hand-runnable command, additive over the existing surface and
creating **no second source of truth** (the boundary-coherence test in
[agent-ergonomics.md](../agent-ergonomics.md) passes: one more _view_ of the
same artifact, not a parallel definition):

```
@tool('forecast', {input: ForecastIn, output: ForecastOut})   ← ONE definition, already exists
      │
      ├─ REST route          (@agentback/rest)      ✅ shipped
      ├─ MCP tool            (@agentback/mcp)        ✅ shipped
      ├─ OpenAPI 3.1         (@agentback/openapi)    ✅ shipped
      ├─ typed HTTP client   (@agentback/client)     ✅ shipped
      ├─ AI SDK host-tool    (@agentback/agents)     ✅ shipped (E-3)
      └─ CLI command         (@agentback/command)    ⬅️ THIS PROPOSAL
```

## What goke and incur teach (and where AgentBack already differs)

|                     | goke                                   | incur                                     | AgentBack today                                          |
| ------------------- | -------------------------------------- | ----------------------------------------- | -------------------------------------------------------- |
| Author a command    | `.command().option(zod).action(ctx)`   | `Cli.create().command({args,options,run})`| **already authored** as `@tool` (no new builder)         |
| Agent detection     | `isAgent()` / `detectAgent()`          | `isAgent`, next-step CTAs                 | — (new; trivial: env sniff)                              |
| Discovery for agents| expose as MCP server + JustBash        | `mcp add`, `skills add`, `--llms` manifest| MCP already shipped; OKF bundle + `generateSkill` (P1-5) |
| Token thrift        | prefer structured output               | **TOON output (~60% vs JSON)**, `--token-limit`/`--token-offset` pagination | — (new; the one feature worth borrowing wholesale) |
| Testability         | injected `{fs, console, process}`      | mount Hono/Elysia; fetch handler          | `createTestApp` + DI already give this                   |

The honest read: goke/incur give you **CLI + MCP** from a bespoke command DSL.
AgentBack gives you **six surfaces** from the `@tool` you already wrote — so a
CLI is a projection, not a second framework. What AgentBack should _borrow_ from
incur is the **agent-thrift output layer** (structured envelopes, token budget,
pagination); what it should _not_ borrow is a `.command()` builder — that would
reintroduce the second source of truth this framework deletes.

## The keystone: it reuses `callTool`, exactly like `toHostTools`

This is why the proposal is small. `MCPServer` already exposes the two public
methods E-3 leans on, and they are protocol-agnostic:

- `listTools(): ToolBinding[]` (mcp.server.ts:153) — every registered tool with
  its `meta` (`name`, `description`, `title`, `input`/`output` Zod, `confirm`).
- `callTool(name, input, {principal?, ctx?, binding?})` (mcp.server.ts:197) —
  runs the **full** dispatch: Zod input validation, principal binding, the
  `@authorize` voter chain, resolution through the tool's own binding
  (constructor `@inject` honored), metering hooks, output validation. Returns
  the **unwrapped**, output-validated result — never an MCP envelope. Works
  **before `app.start()`** (discovery is a container scan).

So the projection is structurally identical to `toHostTools` — only the frontend
changes from "AI SDK `ToolSet`" to "argv parser + serializer":

```ts
// @agentback/command — the whole idea, minus the argv parser
export async function buildCli(app: Context, opts: CliOptions = {}) {
  const mcp = await app.get<MCPServer>(MCPBindings.SERVER.key);
  // Share only the TRANSPORT-NEUTRAL half of @agentback/agents' filterTools
  // (include/exclude, scope gate, confirm-tool guard, dedup) — extract it to
  // @agentback/mcp as a thin predicate (eng review, outside voice finding 5).
  // Do NOT hoist the WHOLE thing: filterTools also bakes in the OpenAI/Anthropic
  // tool-name regex (host-tools.ts:24) and "toHostTools:"-worded errors — an
  // AI-provider constraint that has no business in mcp core or a CLI. That
  // provider-name check stays in @agentback/agents. Extracting the shared core
  // must not churn the just-shipped agents package's behavior (a922ea8).
  const tools = filterCommandTools(mcp.listTools(), opts);
  return async (argv: string[]) => {
    const {name, rest} = splitCommand(argv);           // "forecast" + flags
    const tool = tools.find(t => t.meta.name === name) ?? die(usage(tools));
    const input = argvToBundle(rest, tool.meta.input);  // ← the ONE new part
    const result = await mcp.callTool(name, input, {
      principal: cliPrincipal(app),                     // see identity below
      binding: tool,                                    // skip the by-name scan
    });
    process.stdout.write(serialize(result, detectFormat()));  // json | toon | text
  };
}
```

```
CLI invocation — data flow (identical spine to an agent turn)

  argv                     @agentback/command              @agentback/mcp
   │  my-svc forecast            │                               │
   │    --city Tokyo             │                               │
   ├────────────────────────────►│                               │
   │            argvToBundle(rest, ForecastIn)  ← NEW parse frontend
   │                             │  callTool('forecast', bundle, │
   │                             │    {principal, binding})      │
   │                             ├──────────────────────────────►│
   │                             │        (same pipeline as REST/MCP/agent:
   │                             │         @authorize → Zod in → @inject weave
   │                             │         → method → Zod out, UNWRAPPED)
   │                             │◄──────────────────────────────┤
   │   serialize(result, fmt) → stdout                           │
   │◄────────────────────────────┤                               │
```

Consequences (mirroring E-3's, because it is the same seam):

- **Policy is uniform.** A CLI-invoked tool passes the same `@authorize` voters
  and metering hooks as an MCP `tools/call`. No privileged side door.
- **Coherence is structural.** If `dispatchTool` grows semantics, the CLI
  inherits them for free.
- **`confirm:` tools:** unlike the agent projection, a CLI _can_ carry a
  confirmation round-trip (`--yes` re-invokes with the token, or a two-call
  flow). v1 keeps parity with E-3 (**excluded**, throw on include) and revisits
  in the approval-flows work — a terminal is arguably the _best_ place to prompt.

## The one thin new part: `argvToBundle`

Everything above is reuse. The new code is the argv→slot-0-bundle adapter — the
CLI analog of `zod-bridge.ts` mapping HTTP path/query/body into the validated
`{body, path, query, headers}` bundle. It is **not** a bespoke flag parser
(eng review A1): tokenizing is `node:util`'s built-in `parseArgs`, and
coercion/validation is the tool's own `input:` Zod object — the same schema the
HTTP body uses. For MCP a tool's `input:` **must** lower to a `z.object` root
(CLAUDE.md rule), which is exactly what a flag parser needs:

- **Each top-level key of `input:` → a `--flag`.** `ForecastIn = z.object({city,
  units})` → `--city <str> --units <enum>`. Types, defaults, enum choices, and
  `--help` text derive from the Zod schema — no duplication, the goke/incur core
  promise, but from a schema the app _already has_.
- **The typed-vs-string impedance is the real work (eng review ★★★ + outside
  voice, findings 1–2).** The draft claimed "Zod does the coercion." It does
  **not**, and this is the keystone the whole "small" estimate rests on. An
  app's `@tool` `input:` schemas are authored **once** for MCP/REST/AI-SDK — all
  of which deliver **already-typed JSON** — so authors write `z.number()` /
  `z.boolean()`, never `z.coerce.*`. Argv delivers strings, so `callTool`'s
  `standardParse(tool.meta.input, …)` (mcp.server.ts:400) rejects `"18"` for a
  numeric field. The "one schema, six surfaces" thesis genuinely bends here:
  five surfaces get parsed JSON, only the CLI gets strings. So `argvToBundle`
  must **deep-walk the Zod schema** and coerce per field off the emitted
  JSON-Schema types (`schemaToOpenApiSchema` already produces them), unwrapping
  `ZodOptional`/`ZodDefault`/`ZodEffects`/`ZodPipeline`. That walk is _also_
  what tells `parseArgs` each flag's arity (value vs. boolean) — the existing
  deploy parser hardcodes `VALUE_FLAGS`/`BOOL_FLAGS` (args.ts:23–35) for exactly
  this reason. This is the genuinely load-bearing code, not a footnote; its own
  unit test is a v1 requirement.
- **Boolean flags are a landmine.** `z.coerce.boolean("false") === true` (any
  non-empty string is truthy), and `node:util.parseArgs` has **no `--no-flag`
  negation** — so `--flag false` must be handled by the schema-walk (treat the
  field as a boolean flag: present ⇒ true, `--no-flag` ⇒ false), never by
  string-coercing the value. Called out so the implementer doesn't ship the
  silent-true bug.
- **stdin for the body-shaped case.** `--input @file.json` / `--input -` (read
  stdin) covers deeply nested inputs that don't want twelve flags — the escape
  hatch agents reach for when piping.

Scope guard: v1 supports flat and one-level-nested objects (`--foo.bar`); arrays
via repeat (`--tag a --tag b`); `z.discriminatedUnion` inputs are rejected at
build time with the tool named (same doctrine as the MCP object-root rule). It
does **not** try to be a general argv library — no subcommand trees beyond
`<tool-name> <flags>`, no positional-arg inference in v1 (every field is a named
flag; positional mapping is an open question).

## Scripting/agent-mode surface

Beyond "it runs," the extras that make the CLI good in a script or an
agent-driven shell:

1. **Explicit `--format`, not env-sniffing (eng review, outside voice
   finding 8).** The draft inferred agent-mode from `CLAUDECODE`/`CURSOR_*`/`CI`.
   `CI=true` is set in **every** pipeline — including the app's own test suite —
   so sniffing it would silently flip output format exactly where deterministic
   output matters most. So the format is an **explicit flag**: `--format
   text|json|toon`, default chosen by a **non-TTY stdout** check only
   (`text` when attached to a terminal, `json` when piped). No brittle
   product-name sniffing on the value path. **Success output is the tool's bare,
   output-validated result — the same body the REST route returns** (eng review
   C1): no `{ok, data}` wrapper, because the process **exit code** already
   carries success/failure (Unix convention; scripts read `$?`). Failure prints
   the `AgentError`/`ErrorCodes` envelope to **stderr** and exits non-zero — one
   error contract across all surfaces, no third _success_ shape. (The envelope
   is errors-only; success is never wrapped — this is what reconciles the
   draft's contradiction the outside voice flagged in finding 6.)
2. **Discovery without config.** `my-svc --llms` prints a machine-readable tool
   manifest; `my-svc <tool> --help` prints one tool's schema. **Reuse, don't
   reinvent:** the manifest is the `@agentback/introspection` inventory / OKF
   bundle (already deterministic, schema-indexed), and `--skill` can emit the
   P1-5 `generateSkill()` document. incur hand-rolls `skills add`/`--llms`;
   AgentBack already generates both artifacts from the registry.
3. **Token thrift (borrow from incur).** Optional TOON output and
   `--token-limit`/`--token-offset` pagination on large results, priced with the
   existing `estimateTokens()` (`packages/mcp/src/tool-cost.ts`). This is incur's
   headline feature and the one piece of genuinely new value; gate it behind a
   flag so the default stays boring JSON.

## Identity in a CLI (the seam that needs a decision)

REST/MCP get their principal from a transport (`REQUEST_AUTH`, a bearer token).
A CLI has no transport. Options, in order of recommendation:

- **v1: a single local principal**, mirroring `MCPServer`'s `config.localPrincipal`
  fallback — a CLI run is "the operator", `@authorize` voters see one identity.
  Least surprising; matches how the deploy CLI already runs.
- **v2: `--as <principal>` / env**, for scripting multiple identities.
- **Non-goal:** a login/session store in the CLI. If you need per-user auth, that
  is what the REST surface is for; the CLI is an operator/agent-local surface.

This must be explicit because a tool guarded by `@authorize` will otherwise
"mysteriously" deny from the CLI (the exact failure E-3's error table calls out).

## Shape (mirrors `@agentback/agents`)

```
@agentback/command          (optional package — never a core dep)
  src/
    keys.ts                  CommandBindings (if any DI surface is needed)
    build-cli.ts             buildCli(app, opts) → (argv) => Promise<void>
    argv-bundle.ts           parseArgs opts + JSON-Schema-typed coercion  ← the new code
    serialize.ts             json | toon | text serializers (bare result; err→stderr)
    discovery.ts             --llms (introspection/OKF) + --skill (generateSkill) wiring
    detect.ts                detectFormat()  (TTY check only — no product-name sniff)
  README.md
```

Consumer wiring — one file, next to their existing entrypoint:

```ts
#!/usr/bin/env node
import {createApp} from './app.js';          // their existing AgentBack app factory
import {buildCli} from '@agentback/command';

const app = await createApp();
await app.start();                            // REQUIRED (eng review T2): DB pools,
                                              // config, messaging, actors init in
                                              // LifeCycleObserver.start(). Skipping it
                                              // leaves stateful tools half-bound, and
                                              // app.stop() without start() is a no-op
                                              // (application.ts:400).
const run = await buildCli(app, {include: ['forecast', 'geocode']});  // least privilege
try {
  await run(process.argv.slice(2));
} finally {
  await app.stop();                           // now meaningful: drains pools, runs onStop
}
```

**Boot cost is the honest trade-off (eng review T2).** `start()` pays every
observer's startup — a Postgres pool connect, config load, queue attach — on
**every** `my-svc forecast` invocation. That is the price of correctness for a
per-process CLI; a lazy per-tool start (only the observers a tool needs) is real
design work deferred to v2 (see NOT in scope). Tool discovery itself
(`buildCli`) still works pre-`start()`; it is the _invocation_ that needs a
started app.

`create-agentback` could add a `--cli` flag that scaffolds this file + a `bin`
entry, so `npm create agentback my-svc --cli` yields a service that is a server
_and_ a hand-runnable command.

## Testing

- **Unit** (`packages/command`): `argvToBundle` derives flags from a Zod object;
  coercion defers to Zod (bad `--units` → the schema's issue, not a parser
  error); `--input @file`/`-` paths; discriminated-union input rejected at build
  time with the tool named; `filterTools` parity with E-3 (shared filter).
- **Integration** (`@agentback/testing`): build a CLI over a test app, invoke a
  tool, assert (a) the result equals the same tool called over MCP (the
  cross-surface identity test that proves "one source of truth"), (b) an
  `@authorize`-denied tool exits non-zero with the `AgentError` envelope **on
  stderr**, (c) `--format json` emits the bare result while default TTY mode
  emits text, (d) a metering sink records one event per CLI invocation with the
  local principal, (e) a **`z.number()`/`z.boolean()` field authored without
  `z.coerce`** accepts a string argv value (the coercion-walk regression), (f) a
  tool needing a lifecycle-started dependency works only after `app.start()`.
- **Example:** `examples/hello-command` (or a `--cli` variant of `hello-mcp`)
  showing `my-svc forecast --city Tokyo` and `my-svc --llms`.

## Out of scope (v1)

- **A `.command()` builder.** The whole point is that the `@tool` _is_ the
  command; a second authoring path would recreate the drift this deletes.
- **Interactive prompts / TUI.** A `--yes`-or-fail non-interactive default; a
  human-prompt layer (and the `confirm:` round-trip it would enable) can come
  later.
- **Positional args.** Every input field is a named `--flag` in v1; positional
  inference (`my-svc forecast Tokyo`) is an open question, not a v1 promise.
- **Streaming (`streamOf:`) tools deliver buffered, not incremental (outside
  voice finding 9).** `callTool` drains an async-iterable result into a
  collected array before returning (mcp.server.ts:452-471), and `PROGRESS` is a
  no-op off-transport — so a `streamOf` tool blocks until completion and dumps
  the whole array. Incremental NDJSON-to-stdout (the thing a terminal is best
  at) is a v2 item; v1 documents the buffered behavior rather than pretending to
  stream.
- **Lazy per-tool lifecycle start.** v1 does a full `app.start()` per invocation
  (eng review T2); starting only the observers a tool needs — to cut boot cost
  on a cold DB pool — needs dependency-graph analysis the framework doesn't
  expose today. Deferred.
- **Nested subcommand trees.** `<tool-name> <flags>` only; grouping tools into
  `my-svc weather forecast` is speculative until an app has enough tools to need
  it.
- **Shipping a global binary.** The consumer owns their `bin`; this package is a
  library that builds the runner, not a CLI the framework installs.

## Open questions

1. **Name.** `@agentback/command` vs `@agentback/cli-tools` vs `@agentback/argv`.
   `command` reads best and pairs with "the `@tool` is the command," but risks
   confusion with the deploy `@agentback/cli`. Decide before first publish.
2. **Positional args.** Worth the ergonomic win (`forecast Tokyo`) or a
   schema-ambiguity trap (which field is positional)? Lean: opt-in via a
   `.meta({positional: 'city'})` marker, deferred past v1.
3. **`confirm:` tools in a terminal.** _(Resolved, eng review — hold parity.)_ A
   CLI is arguably the ideal host for a confirmation prompt, but v1 keeps E-3's
   exclusion: `filterTools` throws if an include list names a `confirm:` tool.
   Reason: no confirm-token plumbing before the shared approval-flows design
   settles, and one consistent rule across both projections. Revisit with
   approval-flows.
4. **REST routes too, or tools only?** _(Resolved, eng review — tools only in
   v1.)_ `@get('/hello/{name}')` is also a `callTool`-shaped invocation in
   spirit, but it goes through REST dispatch, not `callTool`, so it needs a
   second invocation + identity adapter. v1 projects `@tool` classes only (the
   one clean seam); a unified invocation port that also covers `@api` routes is
   deferred.
5. **Should this subsume `@agentback/cli`'s ops commands?** Probably not — deploy
   is framework tooling, not app tools — but the two CLIs sharing an argv layer
   is worth a look once both exist.

## Boundary recap

| This package provides                          | You provide                              |
| ---------------------------------------------- | ---------------------------------------- |
| tool → CLI projection (`buildCli`)             | which tools (`include`) + the `bin` file |
| argv→Zod parse + coercion + bare-result/`--format` output | the `@tool` classes (already written)    |
| `--format`/`--llms`/`--skill` scripting surface | `app.start()`/`stop()` in the `bin`      |
| the same `callTool` pipeline (auth, metering)  | the local-principal policy decision      |

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1d / CC: ~1h)** — argv-bundle — Schema-walk coercion
  - Surfaced by: Test review ★★★ + outside voice findings 1–2 — authored `z.number()`/`z.boolean()` reject string argv
  - Deep-walk the `z.object`, coerce each string argv value per the emitted JSON-Schema type, unwrap `ZodOptional`/`ZodDefault`/`ZodEffects`/`ZodPipeline`; booleans as flags (present ⇒ true, `--no-flag` ⇒ false), never string-coerced.
  - Files: `packages/command/src/argv-bundle.ts`
  - Verify: unit test — a coerce-free `z.number()` field accepts `--n 18`
- [ ] **T2 (P1, human: ~30min / CC: ~10min)** — command-lifecycle — `start()`/`stop()` around the runner
  - Surfaced by: Eng review T2 / outside voice finding 4 — stateful tools half-bound without `start()`
  - Files: `packages/command/src/build-cli.ts`
  - Verify: integration — a DB-backed tool works only after `app.start()`
- [ ] **T3 (P1, human: ~2h / CC: ~20min)** — mcp — Extract thin transport-neutral filter to `@agentback/mcp`
  - Surfaced by: Outside voice finding 5 — wholesale hoist drags the provider-name regex into core + churns the shipped `agents` pkg
  - Share include/exclude/scope/dedup/confirm; leave the provider-name check in `@agentback/agents`; no behavior change to `agents`.
  - Files: `packages/mcp/src/`, `packages/agents/src/host-tools.ts`
  - Verify: `@agentback/agents` tests unchanged; new `filterCommandTools` unit tests
- [ ] **T4 (P1, human: ~2h / CC: ~20min)** — command-testing — Cross-surface identity test
  - Surfaced by: Test review — the crown-jewel "one source of truth" proof
  - CLI `callTool` result **==** MCP `callTool` result for the same tool + input.
  - Files: `packages/command/src/__tests__/`
  - Verify: the assertion fails if the two surfaces ever diverge
- [ ] **T5 (P2, human: ~1h / CC: ~15min)** — command-serialize — Explicit `--format`, bare success / stderr error
  - Surfaced by: Outside voice finding 8 + eng review C1
  - `--format text|json|toon`, default by non-TTY stdout only; never sniff `CI`/`CLAUDECODE` on the value path; success = bare result, error = `AgentError` on stderr + non-zero exit.
  - Files: `packages/command/src/serialize.ts`, `packages/command/src/detect.ts`
- [ ] **T6 (P3, human: ~1h / CC: ~15min)** — command-serialize — Document buffered streaming
  - Surfaced by: Outside voice finding 9 — `callTool` drains `streamOf` into an array (mcp.server.ts:452-471)
  - README: v1 delivers buffered results; incremental NDJSON deferred to v2.
  - Files: `packages/command/README.md`

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 9 findings (2 critical), all folded via doc amendments; 5 decisions locked |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Decisions locked (2026-07-06):** A1 stdlib `parseArgs` + Zod coercion (no bespoke parser); A2 tools-only v1 (not REST routes); C1 bare result on stdout, errors→stderr envelope; confirm tools excluded (E-3 parity); T1 audience reframed **operator-first** (agents already have lossless stdio MCP); T2 always `app.start()`/`stop()`; scope kept **own package, full v1** (user override of the outside voice's trim). Correctness fixes absorbed: schema-walk coercion + boolean landmine (findings 1–2), thin filter predicate not wholesale hoist (finding 5), explicit `--format` not `CI`-sniff (finding 8), buffered-streaming documented (finding 9).

**CROSS-MODEL:** Both reviewers agreed the argv-string-vs-typed-JSON coercion is the real work and the draft's `{ok,data}` envelope contradicted the bare-result decision (both fixed). The outside voice went further on strategy (stdio MCP already serves agents) — user accepted the operator-first reframe; and on scope (thin function vs package) — user kept the package. No unresolved tension: every cross-model point was decided by the user.

**VERDICT:** ENG CLEARED (PLAN) — ready to implement in task order T1→T6 (T1–T4 are P1). Operator-first framing and the schema-walk coercion are the load-bearing changes from this review.

NO UNRESOLVED DECISIONS
