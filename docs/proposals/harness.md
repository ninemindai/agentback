# Proposal: `@agentback/harness` — opt-in agent harness for AgentBack apps

**Status:** draft / design sketch
**Backing library:** [AI SDK v7](https://ai-sdk.dev) — `ai` (`ToolLoopAgent`) and `@ai-sdk/harness` + adapters (`@ai-sdk/harness-claude-code`, `-codex`, `-deepagents`, `-opencode`, `-pi`) + sandbox providers (`@ai-sdk/sandbox-vercel`, `@ai-sdk/sandbox-just-bash`). The harness packages are **experimental** ("expect breaking changes between releases").
**Relationship to prior art:** the fourth application of the `@agentback/chat` playbook (see [chat-channels.md](chat-channels.md)) — wrap an experimental Vercel SDK behind AgentBack wiring, optional peer deps, consumer constructs the SDK object, one package absorbs the churn. **Not** related to `console-chat`: that is a dev-tool dock running a coding agent on the _local working tree_ over ACP; this is an app capability running agents against _cloud sandboxes_ (or plain model loops) from production code.

## Thesis

AgentBack's identity is the **served** side of the agent ecosystem: one Zod schema set projected as REST routes, MCP tools, chat handlers, OpenAPI, and OKF docs. But an AgentBack app sometimes needs to be a **caller** too — run an agent turn as part of handling a request, a job, or a chat mention. Today a dev who wants that hand-rolls the AI SDK integration: construct the agent, remember to destroy sessions, wire nothing into identity or metering, and re-declare tool definitions the app already owns as `@tool` classes.

`@agentback/harness` makes opting into a harness a one-call recipe, and concentrates its value in the one thing only AgentBack can provide: **projecting the app's existing `@tool` surface — same Zod schemas, same dispatch pipeline — as the agent's host-executed tools.** One schema then serves six boundaries: validator, TS type, OpenAPI, MCP `inputSchema`, OKF doc, and AI SDK `ToolSet`. No second source of truth is created (the boundary-coherence test in [agent-ergonomics.md](../agent-ergonomics.md) passes: this is a new _view_ of the same artifact).

## The boundary that must stay explicit

**AgentBack wires what surrounds the loop, never the loop itself** — the same line `@agentback/chat` drew with `thread.post(...)`. The package provides:

- `toHostTools(app)` — the app's `@tool` classes as an AI SDK `ToolSet`
- DI binding for a dev-constructed agent (`HarnessBindings.AGENT`)
- session lifecycle (registry + `app.onStop()` destroy — a leaked harness session is a **billing** cloud sandbox, not just a dangling handle)
- identity attribution + metering of turns via `@agentback/metering`
- Zod-validated config via `@agentback/config`

…and it leaves to the dev: the harness/sandbox/model choice, the credentials, the prompts, and **where turns are exposed** (their own routes/tools/chat handlers — no auto-projected `/agent/run` endpoint; auth, streaming shape, and approval flow are the app's design decisions).

## The keystone: `toHostTools` reuses the MCP dispatch pipeline

This came out of the code, not the whiteboard: `MCPServer` already exposes public `listTools(): ToolBinding[]` and `callTool(name, input)`, and `callTool` runs the **full** pipeline — Zod validation, principal binding, the `@authorize` voter chain, resolution through the tool's own binding (constructor `@inject` honored), metering dispatch hooks, output validation. So the projection does not reimplement `resolveMember`; it wraps the pipeline:

```ts
import {tool, jsonSchema, type ToolSet} from 'ai';

export async function toHostTools(app: Application): Promise<ToolSet> {
  const mcp = await app.get(MCPBindings.SERVER);
  const tools: ToolSet = {};
  for (const t of mcp.listTools()) {
    tools[t.meta.name] = tool({
      description: t.meta.description,
      // meta.input IS the Zod object from @tool — AI SDK accepts Zod /
      // Standard Schema directly; fall back to the emitted JSON Schema
      // (schemaToOpenApiSchema) for exotic vendors.
      inputSchema: t.meta.input ?? jsonSchema({type: 'object'}),
      execute: input => mcp.callTool(t.meta.name, input),
    });
  }
  return tools;
}
```

Consequences of routing through `callTool` instead of calling instances directly:

- **Policy is uniform.** An agent-invoked tool passes the same `@authorize` voters and metering hooks as an MCP `tools/call`. No privileged side door.
- **Coherence is structural.** If `dispatchTool` semantics evolve (hooks, confirmation tools, progress), the projection inherits them.
- **One known seam gap:** `callTool(name, input)` takes no request context, so direct calls run as the **anonymous** principal (documented in `MCPBindings.REQUEST_EXTRA` / `PROGRESS` notes). For agent turns to attribute tool calls to the turn's principal, `callTool` needs an optional third argument (`{ctx}` or `{principal}`) threaded to `dispatchTool(tool, input, ctx)` — a small, backward-compatible `@agentback/mcp` change this proposal requires. Until then, tools invoked by the harness authorize/meter as anonymous.

## Shape (mirrors `@agentback/chat`)

```
@agentback/harness           (optional package — never a core dep)
  src/
    keys.ts                  HarnessBindings.AGENT, .SESSIONS, .CONFIG
    port.ts                  AgentPort: structural {generate, stream, createSession?}
    host-tools.ts            toHostTools(app): ToolSet via listTools/callTool
    session-registry.ts      track live sessions; destroy all on stop
    metering.ts              turn usage → UsageSink (surface: 'agent')
    harness.component.ts     HarnessComponent: config binding + registry
    install.ts               installHarness(app, {agent, ...})
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
import {installHarness, toHostTools, HarnessBindings} from '@agentback/harness';

const app = new RestApplication();
app.component(MCPComponent); // tools to project
app.service(ForecastTools); // @mcpServer class — the tools the agent gets

await installHarness(app, {
  agent: new HarnessAgent({
    harness: claudeCode,
    sandbox: createVercelSandbox({runtime: 'node24', ports: [4000]}),
    tools: await toHostTools(app), // host-executed: run in THIS process
    instructions: '…',
  }),
});
```

`installHarness` binds the agent under `HarnessBindings.AGENT`, wires the session registry into `app.onStop()`, and (when `@agentback/metering` is installed) subscribes turn usage to the bound `UsageSink`.

Consumption is ordinary DI — any controller, `@tool`, `@chatBot`, or job worker:

```ts
@api()
class TaskController {
  constructor(@inject(HarnessBindings.AGENT) private agent: AgentPort) {}

  @post('/tasks', {body: TaskIn, response: TaskOut, status: 202})
  async run(input: {body: z.infer<typeof TaskIn>}) {
    const result = await this.agent.generate({prompt: input.body.prompt});
    return {text: result.text};
  }
}
```

The chat reply-brain (the known delta vs CopilotKit OpenTag) falls out as ~15 lines of _user_ code: an `@onMention` handler pipes `agent.stream()` into `thread.post()`. That is an example (`examples/hello-harness`), not a feature.

## Identity & metering

- **Turn attribution:** `installHarness` reads `SecurityBindings.USER` where the turn is initiated (the controller/handler's request context) and stamps the resulting `UsageEvent`. Turn-level LLM usage comes from the AI SDK result's `usage`.
- **Surface union:** `UsageDescriptor.surface` is currently `'rest' | 'mcp'`; add `'agent'` (one-line union extension in `@agentback/metering`).
- **Tool-call metering is free:** harness→host tool calls go through `callTool` → the existing MCP dispatch hooks, so they meter as `mcp` events already (as anonymous until the principal seam above lands).
- **Quota:** per-principal quota from `@agentback/metering` applies to `'agent'` events like any other — an agent turn becomes a governed operation, not an unmetered side channel.

## Config & secrets

Secrets (harness + sandbox credentials) stay in env, consumed by the dev's own `HarnessAgent` construction — the package never touches them. Non-secret structure (instruction defaults, max concurrent sessions, per-turn timeout) is an optional `HarnessBindings.CONFIG` Zod schema that `@agentback/config` can populate; explicit `installHarness` options win. Fail fast at boot, not on the first turn.

## Caveats, ranked

1. **The harness packages are experimental** and the `ai` major cadence is fast (v5→v6→v7 in about a year). Contain it: structural `AgentPort`, optional peers, imports confined to this package. Core and every other package stay ai-sdk-free.
2. **Bridge-backed harnesses only run in network sandboxes.** Claude Code / Codex / Deep Agents / OpenCode require a real sandbox (`@ai-sdk/sandbox-vercel`); only Pi runs host-process. This is why the package must **not** touch `console-chat` — the local-tree ACP dock and the cloud-sandbox harness are different topologies. If the harness abstraction ever gains a local runtime location, revisit the `acp-session.ts` seam then, separately.
3. **Don't over-build before validating the seam.** v1 is: port + `toHostTools` + session registry + install + metering hook. No agent-as-endpoint, no bundled reply-brain, no session persistence.
4. **Session persistence is actor-shaped — defer it.** `session.detach()`/resume across restarts (stable id, serialized turns, resumable state) overlaps with `@agentback/actors`. If demand appears, it deserves its own design pass rather than a bolt-on store here.
5. **Keep it opt-in** — out of core, out of default `create-agentback` templates, mirroring the other capability packages.
6. **CI hygiene:** an in-repo example would pull experimental `@ai-sdk/harness*` into the workspace lockfile. Mirror the chat approach — a gitignored `spike/hello-harness` against published packages first; decide on `examples/hello-harness` only once the deps stabilize.

## Open questions

1. **Principal propagation through `callTool`** — the required `@agentback/mcp` seam (optional `{ctx}` arg). Land it with v1 or ship v1 with documented anonymous tool calls?
2. **Streaming turns over AgentBack surfaces.** `result.stream` → SSE from a REST route works via the raw-response escape hatch today; does typed streaming (p0-2) want a first-class shape for agent turns?
3. **Approval flows.** Claude Code's adapter supports tool approval; surfacing approvals to an app caller (vs auto-policy) needs a design if anyone asks for human-in-the-loop turns.
4. **Tool subsetting.** `toHostTools(app, {include?/exclude?})` — a 50-tool app probably should not hand the whole surface to every agent. `toolCostReport()` already prices the context cost; a filter option is cheap and likely wanted in v1.

## Recommendation

Proceed in two steps, exactly like chat:

1. **Spike** — gitignored `spike/hello-harness` against published `@agentback/*` + `ai`/`@ai-sdk/harness-*`: construct a `HarnessAgent` (Pi host-process for a creds-free start, or Claude Code + Vercel sandbox), hand it `toHostTools`-projected tools from a real app, run a turn from a controller, verify session destroy on `app.stop()`. Proves the three seam facts: TOOLS (host-executed call round-trips through `callTool`), DI (agent injectable, turn runs from a controller), LIFECYCLE (no leaked sandbox).
2. **Package** — extract the validated seam into `@agentback/harness` (port + `toHostTools` + registry + `installHarness` + metering), plus the small `callTool` principal seam in `@agentback/mcp`.

Ship the **tool projection + DI + lifecycle + identity/metering + config**; leave the **loop, the harness choice, and the exposure surface** to the dev.
