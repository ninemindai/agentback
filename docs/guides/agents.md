# Run AI SDK agents with your app's own tools

`@agentback/agents` lets an AgentBack app be the **caller** side of the agent ecosystem — run a [Vercel AI SDK](https://ai-sdk.dev) agent turn from a controller, a job, or a chat handler — while keeping the framework's one-source-of-truth bet: the agent's tools **are** your registered `@tool` classes, projected. One Zod schema serves six boundaries: validator, `z.infer` type, OpenAPI, MCP `inputSchema`, OKF doc, and AI SDK `ToolSet`.

## The five-minute path

Your app already has the hard part — `@tool` classes serving MCP:

```ts
const ForecastIn = z.object({city: z.string()});

@mcpServer()
class ForecastTools {
  @tool('forecast', {input: ForecastIn, output: ForecastOut})
  async forecast(input: z.infer<typeof ForecastIn>) { … }
}
```

Add the agent (one provider, one env var):

```bash
pnpm add @agentback/agents ai @ai-sdk/anthropic
export ANTHROPIC_API_KEY=...
```

```ts
import {ToolLoopAgent} from 'ai';
import {anthropic} from '@ai-sdk/anthropic';
import {toHostTools} from '@agentback/agents';

const agent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4-5'),
  tools: await toHostTools(app, {include: ['forecast']}),
});

const result = await agent.generate({prompt: 'Forecast for Tokyo?'});
console.log(result.steps); // ← your own @tool, called by the agent
```

`toHostTools` routes every call through `MCPServer.callTool` — the full pipeline (Zod validation, `@authorize` voters, metering hooks, output validation) applies, and `execute` returns the unwrapped, output-validated result. It works before `app.start()`, and it **throws at projection time** on typo'd include names, duplicate names, provider-illegal names, and `confirm:` tools (whose confirmation round-trip can't survive projection).

Run the whole thing with zero credentials: `pnpm -F hello-agents start` drives the loop with a deterministic mock model — see [examples/hello-agents](../../examples/hello-agents).

## Identity, quota, metering: `installAgent`

For a one-off `generate()` the snippet above is complete. Install when you want DI, lifecycle, and governance:

```ts
import {installAgent, AgentBindings, type AgentPort} from '@agentback/agents';

installAgent(app, {agent});

@api()
class TaskController {
  constructor(@inject(AgentBindings.AGENT) private agent: AgentPort) {}

  @post('/tasks', {body: TaskIn, response: TaskOut})
  async run(input: {body: z.infer<typeof TaskIn>}) {
    const result = await this.agent.generate({prompt: input.body.prompt});
    return {text: result.text};
  }
}
```

`AgentBindings.AGENT` is TRANSIENT — each injection resolves a wrapper against the injector's context. In a controller that context is the request child carrying `SecurityBindings.USER`, so per turn the wrapper:

1. reads the **principal** from the request (identity is per-turn, never baked at projection time — `@authorize`-guarded tools authorize as the request's user),
2. checks **quota preflight** (`MeteringBindings.QUOTA`) — a denied turn costs zero model spend (429 `quota_exceeded`),
3. supplies `toolsContext` (principal + turn id) for every projected tool,
4. records one `'agent'` usage event; each tool call's `'mcp'` event shares the turn's `meta.correlationId` and principal,
5. consumes quota post-turn on success. Streams finalize on completion **and** abort.

Sessions created through the wrapped agent (`HarnessAgent`'s `createSession`) register in `AgentBindings.SESSIONS`; `app.stop()` destroys them all — a leaked harness session is a billing cloud sandbox.

`AgentBindings.RAW_AGENT` is the unwrapped escape hatch (no identity, no metering).

## Security posture

Tool results are model inputs: a tool that returns untrusted content can steer the loop (prompt injection). Defaults to copy: **read-only/idempotent tools in the `include` list**, per-principal quota as the blast-radius limiter, and `{scopes}` to apply the same visibility gate as a scoped MCP transport. Side-effecting tools should wait for the approval-flows design; `confirm:` tools are excluded from projection.

## Degraded MCP features under projection

`MCPBindings.PROGRESS` → no-op (streamOf tools drain to a collected array) • `REQUEST_EXTRA` → `undefined` • elicitation/sampling → unavailable • `confirm:` → excluded. Tools relying on these still run, silently degraded.

## Cloud-sandbox harnesses (level 2 — recipe)

`HarnessAgent` (Claude Code / Codex / Pi as wrapped runtimes) satisfies the same `AgentPort`; bridge-backed harnesses require a network sandbox (`@ai-sdk/sandbox-vercel`) and their own credentials. This path is a **manually verified recipe** — the experimental `@ai-sdk/harness*` family is not CI-covered here. See the [package README](../../packages/agents/README.md#cloud-sandbox-harnesses-level-2--recipe-manually-verified-per-release) for the snippet.

Not to be confused with two siblings: `@agentback/actors` (stateful entities behind a stable address — serialized _state_ turns, no LLM) and `console-chat` (a dev-tool dock running a coding agent on your local working tree over ACP — different topology from cloud-sandbox harnesses).

## Design notes

Tested with `ai@7.0.x` (optional peer, loaded lazily — `installAgent`-only consumers never crash without it). Upgrade policy: pin back + patch release when an AI SDK major lands. Full design rationale: [docs/proposals/harness.md](../proposals/harness.md).
