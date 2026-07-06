# Proposal: `@agentback/agents` — opt-in AI SDK agents for AgentBack apps

> **Naming (DX review D19):** originally drafted as `@agentback/harness`, renamed at design stage: the recommended golden path runs a plain `ToolLoopAgent` (no harness), and the AI SDK reserves "harness" for wrapped runtimes like Claude Code. `agents` names the capability accurately for both paths; "harness" remains the level-2 concept. Not to be confused with `@agentback/actors` (stateful entities behind a stable address) — one disambiguating line goes in both READMEs. This file keeps its committed `harness.md` path.

**Status:** draft / design sketch
**Backing library:** [AI SDK v7](https://ai-sdk.dev) — `ai` (`ToolLoopAgent`) and `@ai-sdk/harness` + adapters (`@ai-sdk/harness-claude-code`, `-codex`, `-deepagents`, `-opencode`, `-pi`) + sandbox providers (`@ai-sdk/sandbox-vercel`, `@ai-sdk/sandbox-just-bash`). The harness packages are **experimental** ("expect breaking changes between releases").
**Relationship to prior art:** the fourth application of the `@agentback/chat` playbook (see [chat-channels.md](chat-channels.md)) — wrap an experimental Vercel SDK behind AgentBack wiring, optional peer deps, consumer constructs the SDK object, one package absorbs the churn. **Not** related to `console-chat`: that is a dev-tool dock running a coding agent on the _local working tree_ over ACP; this is an app capability running agents against _cloud sandboxes_ (or plain model loops) from production code.

## Thesis

AgentBack's identity is the **served** side of the agent ecosystem: one Zod schema set projected as REST routes, MCP tools, chat handlers, OpenAPI, and OKF docs. But an AgentBack app sometimes needs to be a **caller** too — run an agent turn as part of handling a request, a job, or a chat mention. Today a dev who wants that hand-rolls the AI SDK integration: construct the agent, remember to destroy sessions, wire nothing into identity or metering, and re-declare tool definitions the app already owns as `@tool` classes.

`@agentback/agents` makes opting into an agent (model loop or full harness) a one-call recipe, and concentrates its value in the one thing only AgentBack can provide: **projecting the app's existing `@tool` surface — same Zod schemas, same dispatch pipeline — as the agent's host-executed tools.** One schema then serves six boundaries: validator, TS type, OpenAPI, MCP `inputSchema`, OKF doc, and AI SDK `ToolSet`. No second source of truth is created (the boundary-coherence test in [agent-ergonomics.md](../agent-ergonomics.md) passes: this is a new _view_ of the same artifact).

## The boundary that must stay explicit

**AgentBack wires what surrounds the loop, never the loop itself** — the same line `@agentback/chat` drew with `thread.post(...)`. The package provides:

- `toHostTools(app)` — the app's `@tool` classes as an AI SDK `ToolSet`
- DI binding for a dev-constructed agent (`AgentBindings.AGENT`)
- session lifecycle (registry + `app.onStop()` destroy — a leaked harness session is a **billing** cloud sandbox, not just a dangling handle)
- identity attribution + metering of turns via `@agentback/metering`
- Zod-validated config via `@agentback/config`

…and it leaves to the dev: the harness/sandbox/model choice, the credentials, the prompts, and **where turns are exposed** (their own routes/tools/chat handlers — no auto-projected `/agent/run` endpoint; auth, streaming shape, and approval flow are the app's design decisions).

## The keystone: `toHostTools` reuses the MCP dispatch pipeline

This came out of the code, not the whiteboard: `MCPServer` already exposes public `listTools(): ToolBinding[]` and `callTool(name, input)`, and `callTool` runs the **full** pipeline — Zod validation, principal binding, the `@authorize` voter chain, resolution through the tool's own binding (constructor `@inject` honored), metering dispatch hooks, output validation. So the projection does not reimplement `resolveMember`; it wraps the pipeline:

```ts
import {tool, jsonSchema, type ToolSet} from 'ai';

export async function toHostTools(
  app: Application,
  opts?: {include?: string[]; exclude?: string[]},
): Promise<ToolSet> {
  const mcp = await app.get(MCPBindings.SERVER);
  const tools: ToolSet = {};
  // filterTools THROWS on duplicate/ambiguous tool names (the mcp-host
  // collision convention): an ambiguous projection is a misconfiguration.
  for (const t of filterTools(mcp.listTools(), opts)) {
    tools[t.meta.name] = tool({
      description: t.meta.description,
      // meta.input IS the Zod object from @tool — AI SDK accepts Zod /
      // Standard Schema directly; fall back to the emitted JSON Schema
      // (schemaToOpenApiSchema) for exotic vendors.
      inputSchema: t.meta.input ?? jsonSchema({type: 'object'}),
      // Identity is PER-TURN, never baked at projection time (outside-voice
      // D21): the turn's principal rides the AI SDK per-call tool context
      // into callTool's optional third arg. execute returns the UNWRAPPED
      // tool result (structured output when an output: schema exists) —
      // never an MCP content envelope (D22).
      execute: (input, callCtx) =>
        mcp.callTool(t.meta.name, input, {principal: principalFrom(callCtx)}),
    });
  }
  return tools;
}
```

The `{include, exclude}` filter is **v1 scope, not future work** (DX review D14): a 30-tool app must not hand the agent 30 tools by default — context cost per turn (`toolCostReport()` prices it) and least privilege both demand an explicit list, and the quickstart example shows `{include: [...]}` so the safe pattern is the copied one.

Consequences of routing through `callTool` instead of calling instances directly:

- **Policy is uniform.** An agent-invoked tool passes the same `@authorize` voters and metering hooks as an MCP `tools/call`. No privileged side door.
- **Coherence is structural.** If `dispatchTool` semantics evolve (hooks, confirmation tools, progress), the projection inherits them.
- **The principal seam lands with v1, and identity is per-turn** (DX review D13, reshaped by outside-voice D21). `callTool(name, input)` takes no request context, so direct calls run as the **anonymous** principal — meaning every `@authorize`-guarded tool would 403 the app's own agent on a secured app's first run. Fix: an optional third argument (`{ctx}` or `{principal}`) on `callTool`, threaded to `dispatchTool(tool, input, ctx)` — small and backward-compatible. Crucially, the principal is **not** a `toHostTools` option (tools are built once; principals arrive per request): it flows per-turn through the AI SDK's per-call tool context (or a request-scoped `AgentPort` resolution). The spike must prove this with an `@authorize`-guarded tool.
- **The execute contract is explicit** (outside-voice D22): `execute` returns the unwrapped tool result — the method's return value, structured when an `output:` schema exists — never an MCP `content`/`structuredContent` envelope. And `toHostTools` must work **before `app.start()`** (the README snippet's ordering) or the ordering constraint gets documented; both are spike criteria.

## Shape (mirrors `@agentback/chat`)

```
@agentback/agents           (optional package — never a core dep)
  src/
    keys.ts                  AgentBindings.AGENT, .SESSIONS, .CONFIG
    port.ts                  AgentPort: structural {generate, stream, createSession?}
    host-tools.ts            toHostTools(app, {include?, exclude?}): ToolSet via listTools/callTool
    session-registry.ts      track live sessions; destroy all on stop
    metering.ts              turn usage → UsageSink (surface: 'agent')
    agents.component.ts      AgentsComponent: config binding + registry
    install.ts               installAgent(app, {agent, ...})
```

### The port is the AI SDK `Agent` interface, structurally

`ToolLoopAgent` and `HarnessAgent` both implement the AI SDK `Agent` shape (`generate()` / `stream()`); `HarnessAgent` adds sessions. `port.ts` types the `agent` option **structurally** against that minimal shape (the `ChatLike` trick), so:

- the same package serves a dev opting into a full harness _or_ a plain model loop — or anything else that satisfies the shape;
- `@ai-sdk/harness` types never enter the package's public signatures;
- `ai` / `@ai-sdk/harness*` are **optional peer deps**, imported only where unavoidable.

### Install (parallel to `installChat`)

```ts
import {HarnessAgent} from '@ai-sdk/harness/agent';
import {claudeCode} from '@ai-sdk/harness-claude-code';
import {createVercelSandbox} from '@ai-sdk/sandbox-vercel';
import {installAgent, toHostTools, AgentBindings} from '@agentback/agents';

const app = new RestApplication();
app.component(MCPComponent); // tools to project
app.service(ForecastTools); // @mcpServer class — the tools the agent gets

await installAgent(app, {
  agent: new HarnessAgent({
    harness: claudeCode,
    sandbox: createVercelSandbox({runtime: 'node24', ports: [4000]}),
    tools: await toHostTools(app), // host-executed: run in THIS process
    instructions: '…',
  }),
});
```

`installAgent` binds the agent under `AgentBindings.AGENT`, wires the session registry into `app.onStop()`, and (when `@agentback/metering` is installed) subscribes turn usage to the bound `UsageSink`.

Consumption is ordinary DI — any controller, `@tool`, `@chatBot`, or job worker:

```ts
@api()
class TaskController {
  constructor(@inject(AgentBindings.AGENT) private agent: AgentPort) {}

  @post('/tasks', {body: TaskIn, response: TaskOut, status: 202})
  async run(input: {body: z.infer<typeof TaskIn>}) {
    const result = await this.agent.generate({prompt: input.body.prompt});
    return {text: result.text};
  }
}
```

The chat reply-brain (the known delta vs CopilotKit OpenTag) falls out as ~15 lines of _user_ code: an `@onMention` handler pipes `agent.stream()` into `thread.post()`. That is an example (`examples/hello-agents`), not a feature.

## Identity & metering

- **Turn attribution:** `installAgent` reads `SecurityBindings.USER` where the turn is initiated (the controller/handler's request context) and stamps the resulting `UsageEvent`. Turn-level LLM usage comes from the AI SDK result's `usage`.
- **Surface union:** `UsageDescriptor.surface` is currently `'rest' | 'mcp'`; add `'agent'` (one-line union extension in `@agentback/metering`).
- **Tool-call metering rides the dispatch hooks — verify, don't assume** (outside-voice D24): host tool calls go through `callTool` → the existing MCP dispatch hooks, so they should meter as `mcp` events — but an in-process synthetic call has no transport metadata/request info, so the spike verifies the hooks behave (it is not assumed "free").
- **Ordering semantics, defined up front** (outside-voice D24): one logical turn emits one `'agent'` event plus N `'mcp'` tool events. Quota is checked **preflight per turn** (before the LLM call spends money); usage is charged **post-turn**; tool-call `'mcp'` events are attributed to the same principal + a shared turn id so sinks can group or dedupe — no double-charging, no mid-turn blocks.
- **Quota:** per-principal quota from `@agentback/metering` applies to `'agent'` events like any other — an agent turn becomes a governed operation, not an unmetered side channel.

## Config & secrets

Secrets (harness + sandbox credentials) stay in env, consumed by the dev's own `HarnessAgent` construction — the package never touches them. Non-secret structure is an optional `AgentBindings.CONFIG` Zod schema that `@agentback/config` can populate; explicit `installAgent` options win. Fail fast at boot, not on the first turn.

**No documentation-only knobs** (outside-voice D24): a config key ships only with its enforcement. `maxConcurrentSessions` / `perTurnTimeout` are in v1 config **only if** `installAgent` wraps turn execution to enforce them; otherwise they are cut from the v1 schema and added when the wrapper exists.

## Developer experience — v1 commitments (from DX review, 2026-07-05)

These are ship-gating commitments, not aspirations. Persona: the existing AgentBack app dev (usually piloting a coding agent) who already has `@tool` classes and budgets ~30 minutes. Full persona card, journey map, and benchmark live in the DX review appendix below.

### Quickstart contract (TTHW ≤ 5 minutes, Competitive tier)

The README leads with the **model-loop golden path**, not the sandbox harness — same package, 3-minute path instead of 20:

1. `pnpm add @agentback/agents ai @ai-sdk/anthropic` (one provider, named explicitly — no provider-choice menu in the quickstart; alternatives live in a later section).
2. `export ANTHROPIC_API_KEY=...` (the only credential the golden path needs).
3. Paste one snippet: `new ToolLoopAgent({model: anthropic('...'), tools: await toHostTools(app, {include: ['forecast']})})` → `agent.generate(...)` → the step log shows **the app's own tool being called**.

The cloud-sandbox `HarnessAgent` path (Vercel sandbox, `@ai-sdk/harness-*`) is the "level 2" section, with every required env var named. Benchmark: Mastra scaffolds a first agent in ~5 min; raw AI SDK is ~5-10 — this package must beat raw AI SDK for its persona (the tools already exist) or it argues for its own removal.

### The magical moment ships as `examples/hello-agents`

The wow is: _an agent calls the `@tool` classes you already wrote, with zero re-declaration_ — `result.steps` printing the tool invocation is the proof of the six-boundary schema story. Delivery vehicle (DX review D9/D12):

- `examples/hello-agents` is **in-repo and runnable** (`pnpm -F hello-agents start`), depending only on `ai` + one provider — **no `@ai-sdk/harness*` in the workspace lockfile**.
- Its CI test runs `toHostTools` + `ToolLoopAgent` against a **mock model** (deterministic, no network, no key), so CI guards the projection seam without inheriting the experimental deps' churn.
- The sandbox-harness variant lives in the README + the gitignored `spike/hello-agents`; it is retested manually per release, not in CI.

### Peer-dependency version matrix (tested-matrix discipline)

- `peerDependencies` declare the **tested major range** (e.g. `ai@^7`), never open-ended.
- The README carries a "tested with" matrix line (e.g. `ai@7.0.x`, `@ai-sdk/harness@x.y`) updated per verified release.
- A CI job pins the tested matrix so upstream breakage is caught here first — the AI SDK shipped three majors in ~a year; without this, every upstream major reads as this package's bug.

### Errors: problem + cause + fix, specified now

Three failure moments are specified at design time (not left to implementation):

1. **Missing peer dep** — lazy imports of `ai`/`@ai-sdk/harness*` are caught and rethrown with the exact install line for the path the dev is on.
2. **Authorization rejection** — the **existing framework error passes through unchanged** (its code and voter context preserved — never recast; outside-voice D24 amended the earlier wrap-in-`AgentError` wording). The package **adds** context alongside it: the tool name, the principal the call ran as, and a README#identity pointer, via the `loggers` diagnostics and the thrown error's `cause`. (Note for implementers: `AgentError`'s constructor option is `{status}` but the instance property is `.statusCode` — agent-error.ts:17.)
3. **Missing model credential** — the provider's error passes through with a one-line wrapper naming the env var the quickstart told the dev to set.

Diagnostics use `loggers('agentback:agents')` (documented in the README: `DEBUG=agentback:agents:*`).

### README must also answer (paper cuts from the DX roleplay)

- **"Do I need `installAgent`?"** — a when-you-need-it box: not for a one-off `generate()`; yes for DI injection, session lifecycle, metering.
- **Streaming a turn from a route** — a documented raw-SSE recipe via `RestBindings.HTTP_RESPONSE` now; typed streaming upgrades when p0-2 lands.
- **Degraded MCP features under host-tool invocation** — a small table: `MCPBindings.PROGRESS` → no-op, `REQUEST_EXTRA` → undefined, elicitation → unavailable; tools relying on them still run, silently degraded.
- **Security posture** (outside-voice D24) — a README section on handing an LLM host-executed tools: recommend read-only/idempotent tools in the `include` list for v1, the `confirm:` tool pattern for side-effecting ones, per-principal quota as the blast-radius limiter, and the prompt-injection boundary (tool results are model inputs — a tool that returns untrusted content can steer the loop).
- **Harness-support honesty** (outside-voice D24) — the sandbox-harness section is labeled **"recipe — manually verified per release"**, not "supported", until CI covers it; the tested-with matrix states which adapter versions the recipe was last verified against.

### Documentation surfaces (v1 ship checklist) + upgrade policy

Per the repo's CLAUDE.md checklist, v1 does not ship without: package README • `docs/packages.md` row • `docs/guides/agents.md` • `skills/agentback/references/agents.md` (the persona's coding agent discovers packages through SKILL.md — without it the package is invisible to the primary user's tooling) • CLAUDE.md capability-list entry • `examples/hello-agents`.

**Upgrade policy:** the README version matrix is the single upgrade truth; when an AI SDK major lands, policy is _pin back + patch release_, announced in the changelog — devs never diagnose upstream churn themselves.

## Caveats, ranked

1. **The harness packages are experimental** and the `ai` major cadence is fast (v5→v6→v7 in about a year). Contain it: structural `AgentPort`, optional peers, imports confined to this package. Core and every other package stay ai-sdk-free.
2. **Bridge-backed harnesses only run in network sandboxes.** Claude Code / Codex / Deep Agents / OpenCode require a real sandbox (`@ai-sdk/sandbox-vercel`); only Pi runs host-process. This is why the package must **not** touch `console-chat` — the local-tree ACP dock and the cloud-sandbox harness are different topologies. If the harness abstraction ever gains a local runtime location, revisit the `acp-session.ts` seam then, separately.
3. **Don't over-build before validating the seam.** v1 is: port + `toHostTools` + session registry + install + metering hook. No agent-as-endpoint, no bundled reply-brain, no session persistence.
4. **Session persistence is actor-shaped — defer it.** `session.detach()`/resume across restarts (stable id, serialized turns, resumable state) overlaps with `@agentback/actors`. If demand appears, it deserves its own design pass rather than a bolt-on store here.
5. **Keep it opt-in** — out of core, out of default `create-agentback` templates, mirroring the other capability packages.
6. **CI hygiene — split, don't dodge (amended by DX review D12):** `examples/hello-agents` ships in-repo but depends only on `ai` + one provider, with a mock-model CI test — the experimental `@ai-sdk/harness*` family stays out of the workspace lockfile. The gitignored `spike/hello-agents` still covers the sandbox-harness path (manual retest per release). The chat precedent (spike-only, no example) is explicitly **not** followed: it left devs nothing to crib from.

## Open questions

_(Resolved by the DX review: principal propagation → **lands with v1**, D13. Tool subsetting → **`{include/exclude}` in v1**, D14. Streaming → documented raw-SSE recipe in v1; the typed shape below stays open.)_

1. **Typed streaming for agent turns.** The raw-SSE recipe ships in the README now; does typed streaming (p0-2) want a first-class shape for agent turns when it lands?
2. **Approval flows.** Claude Code's adapter supports tool approval; surfacing approvals to an app caller (vs auto-policy) needs a design if anyone asks for human-in-the-loop turns.

## Recommendation

Proceed in three steps (chat's spike→package flow, with the spike split so the golden path is proven first):

1. **Spike, phase 1 — the golden path first** (reordered by outside-voice D23: v1's selling point is the model loop, so it gets proven first, creds-cheap). Gitignored `spike/hello-agents` against published `@agentback/*` + `ai`: run the **exact README quickstart snippet** — `ToolLoopAgent` + `toHostTools`-projected tools from a real app. Proves: TOOLS (host-executed call round-trips through `callTool`), IDENTITY (an `@authorize`-guarded tool authorizes under the **per-turn** principal — D21), SHAPE (`execute` returns the unwrapped/structured result, no MCP envelope — D22), ORDERING (`toHostTools` works pre-`start()` or the constraint is documented — D22), METERING (dispatch hooks fire correctly on synthetic in-process calls — D24), DI (agent injectable, turn runs from a controller).
2. **Spike, phase 2 — harness topology.** Construct a `HarnessAgent` (Pi host-process for a creds-free start, or Claude Code + Vercel sandbox), same projected tools, verify session destroy on `app.stop()` (LIFECYCLE — no leaked billing sandbox). Phase 2's outcome also decides whether harness content belongs in the v1 README at all, or ships later as the level-2 recipe.
3. **Package** — extract the validated seam into `@agentback/agents` (port + `toHostTools` with `{include/exclude}` + registry + `installAgent` + metering), plus the small `callTool` principal seam in `@agentback/mcp`, honoring every item in "Developer experience — v1 commitments" (quickstart contract, `examples/hello-agents`, peer matrix, errors, security section, docs checklist).

**v1 acceptance criteria (DX review D20, baseline honesty per D23):** (1) a stopwatch run of the README quickstart **starting from `examples/hello-mcp`** (the persona's real starting point: an app that already has tools) lands **≤ 5 minutes**, recorded in the v1 PR description; (2) the metering `'agent'` surface is the adoption signal — `UsageEvent`s with `surface: 'agent'` prove turns run in real apps (no new telemetry; the post-ship `/devex-review` boomerang measures against both).

Ship the **tool projection + DI + lifecycle + identity/metering + config**; leave the **loop, the harness choice, and the exposure surface** to the dev.

## Appendix: DX review artifacts (plan-devex-review, 2026-07-05)

### Developer persona

- **Who:** existing AgentBack app dev — TypeScript dev (usually piloting a coding agent) with a running app that already has `@tool` classes.
- **Context:** wants the app to run an agent turn (chat reply-brain, background task) without leaving the framework.
- **Tolerance:** ~30 min to a compiling, running turn; abandons if credentials or version churn eat the budget.
- **Expects:** README with copy-paste install + snippet that compiles first try; an `examples/hello-*` to crib from; DI/lifecycle handled like every other `@agentback` package.

### Developer perspective (empathy narrative, pre-fix baseline)

_The implementer should read this and feel what the developer feels. This traces the ORIGINAL proposal's path; the v1 commitments above exist to delete each of these moments._

"My app has six `@tool` classes serving MCP. I want a Slack reply-brain, and I see `@agentback/agents` in the packages catalog. The install line: five packages, three marked experimental. Fine. I paste the snippet. `createVercelSandbox` — wait, do I need a Vercel account? Which env var? The README says 'bring your own credentials' but not which ones. I look for `examples/hello-agents` — it doesn't exist. I copy the controller example; it compiles. First run: missing API key — my fault, fixed. Second run: the turn works, but my forecast tool returns a 403 — my `@authorize` voter rejected it, because harness tool calls run as the anonymous principal. Twenty-five minutes in, my own tools are telling my own agent 'access denied', and nothing in the error says why."

### Competitive DX benchmark

| Tool                                         | TTHW              | Notable DX choice                                               |
| -------------------------------------------- | ----------------- | --------------------------------------------------------------- |
| Mastra                                       | ~5 min            | `npm create mastra@latest` scaffolds agent + local playground   |
| Vercel AI SDK (raw)                          | ~5-10 min         | One file: `new ToolLoopAgent({model, tools})`                   |
| LangGraph TS                                 | ~30+ min          | Graph concepts before first agent                               |
| `@agentback/agents` (as originally proposed) | ~20-30 min        | tool projection, but 5-pkg install + sandbox creds + no example |
| `@agentback/agents` (v1 commitments)         | **≤5 min target** | golden path: 3 packages, 1 env var, first turn calls YOUR tool  |

Sources: [WorkOS Mastra quickstart](https://workos.com/blog/mastra-ai-quick-start), [Mastra docs](https://mastra.ai/guides/getting-started/quickstart), [AI SDK ToolLoopAgent reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent), [Speakeasy framework comparison](https://www.speakeasy.com/blog/ai-agent-framework-comparison/).

### Developer journey map (post-review)

| Stage          | Developer does                         | Friction resolution                                         | Status |
| -------------- | -------------------------------------- | ----------------------------------------------------------- | ------ |
| 1. Discover    | packages.md row, SKILL.md reference    | doc-surfaces ship checklist (D16)                           | fixed  |
| 2. Install     | `pnpm add @agentback/agents ai …`      | tested version matrix + CI pin (D11)                        | fixed  |
| 3. Hello World | quickstart → first turn calls own tool | ToolLoopAgent-first golden path + `hello-agents` (D8/9/12)  | fixed  |
| 4. Real Usage  | `@authorize`'d tools, 30-tool apps     | principal seam in v1 (D13); `{include/exclude}` in v1 (D14) | fixed  |
| 5. Debug       | authz / peer-dep / key failures        | Errors section: `AgentError` + hints + loggers (D15)        | fixed  |
| 6. Upgrade     | `ai@8` lands                           | version matrix + pin-back policy (D16)                      | fixed  |

### First-time developer confusion report (post-fix roleplay)

All four residual confusions addressed (D17): provider choice paralysis → one named provider in the quickstart; "do I need `installAgent`?" → when-you-need-it box; streaming from a route → documented raw-SSE recipe; silently degraded MCP features under `callTool` → README table.

### NOT in scope (considered, deferred)

- **Console playground tab** (type a prompt in `/console`, watch a turn hit your tools) — Stripe-Shell-tier wow, but a big scope add that conceptually collides with `console-chat`'s dock; revisit only after v1 demand signals.
- **`create-agentback --template agent` scaffold** — Champion-tier (<2 min) TTHW play; premature for an exploratory package wrapping an experimental SDK.
- **CI coverage of the sandbox `HarnessAgent` path** — deliberately manual (spike) so experimental deps stay out of the lockfile; accepted risk.
- **Session persistence / resume** — actor-shaped; own design pass if demand appears (unchanged from caveat #4).

### What already exists (reuse, don't rebuild)

- `MCPServer.listTools()` / `callTool()` — the full dispatch pipeline the projection wraps (mcp.server.ts:126/167).
- `AgentError` (+ `.statusCode` property quirk, agent-error.ts:17) and `loggers()` — the error/diagnostics machinery the Errors section commits to.
- `toolCostReport()` — prices the tool-surface context cost the `{include}` filter manages.
- `createTestApp` (@agentback/testing) — the harness for `hello-agents`'s mock-model CI test.
- The `@agentback/chat` README's "what this package does — and deliberately doesn't" section — the boundary-recap pattern this README should copy.

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status         | Findings                                                                             |
| ------------- | --------------------- | ------------------------------- | ---- | -------------- | ------------------------------------------------------------------------------------ |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 0    | —              | —                                                                                    |
| Outside Voice | `codex exec` (plan)   | Independent 2nd opinion         | 1    | RAN (codex)    | ~20 challenges; 4 accepted as amendments (D21–D24), 2 noted as context-miss/settled  |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 0    | — (stale >7d)  | prior eng reviews (2026-06) covered other proposals                                  |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 0    | —              | —                                                                                    |
| DX Review     | `/plan-devex-review`  | Developer experience gaps       | 1    | CLEAR (POLISH) | score: 4/10 → 8.5/10, TTHW: 20-30 min → ≤5 min target; 25 decisions (D1–D25), 0 open |

**CROSS-MODEL:** Codex confirmed the review's structural direction (package seam, callTool reuse, no auto endpoint) and overturned one implementation sketch: per-request principal cannot be a boot-time `toHostTools` option (D21 accepted). Codex's CLAUDE.md/AGENTS.md doc-surface objection was a repo-context miss (this repo's checklist genuinely lives in CLAUDE.md + skills/agentback); its "package too thin" challenge re-litigates the settled package-vs-recipe decision — both noted, not actioned.
**VERDICT:** DX CLEARED — design amended and hardened; eng review required before implementation (run `/plan-eng-review` on this proposal; the June eng-review entries are stale and covered other plans).

NO UNRESOLVED DECISIONS
