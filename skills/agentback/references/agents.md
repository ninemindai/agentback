# Agents — run AI SDK agents with the app's own tools

`@agentback/agents` projects registered `@tool` classes as a Vercel AI SDK
agent's **host-executed tools** and wires per-turn identity, quota, sessions,
and metering around the loop. The loop itself (model, provider, credentials,
prompts) stays yours. `ai` is an **optional peer dep**, loaded lazily.

Do not confuse with `@agentback/actors` (stateful entities, serialized state
turns, no LLM) or `console-chat` (dev-console coding-agent dock over ACP).

## The golden path (model loop, one env var)

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
  // Least privilege: name the tools. Typos THROW at projection time.
  tools: await toHostTools(app, {include: ['forecast']}),
});
const result = await agent.generate({prompt: 'Forecast for Tokyo?'});
// result.steps shows the app's own @tool being called — zero re-declaration.
```

Key facts about `toHostTools(app, {include?, exclude?, scopes?})`:

- Every call routes through `MCPServer.callTool` → full pipeline: Zod input
  validation, `@authorize` voters, metering dispatch hooks, output validation.
- `execute` returns the **unwrapped, output-validated** method result — never
  an MCP `content` envelope.
- Works **before `app.start()`** (tool discovery is a container scan).
- The `@tool`'s Zod object IS the AI SDK `inputSchema` — same source of truth.
- Throws at projection time on: include/exclude typos (lists available
  tools), duplicate names, provider-illegal names (`^[a-zA-Z0-9_-]{1,64}$`),
  and `confirm:` tools in an include list (`confirm:` never projects — the
  confirmation round-trip cannot survive projection).
- `{scopes}` applies the same visibility gate as a scoped MCP transport.
- Async-generator (`streamOf`) tools drain to a collected array.
- Degraded under projection: `MCPBindings.PROGRESS` → no-op, `REQUEST_EXTRA`
  → undefined, elicitation → unavailable.

## DI + identity + metering: `installAgent`

Skip it for a one-off `generate()`. Install for DI injection, session
lifecycle, and governance:

```ts
import {installAgent, AgentBindings, type AgentPort} from '@agentback/agents';

installAgent(app, {agent});

@api()
class TaskController {
  constructor(@inject(AgentBindings.AGENT) private agent: AgentPort) {}

  @post('/tasks', {body: TaskIn, response: TaskOut})
  async run(input: {body: z.infer<typeof TaskIn>}) {
    // Runs AS the request's principal: @authorize'd tools authorize
    // correctly; usage is attributed per principal.
    return {
      text: (await this.agent.generate({prompt: input.body.prompt})).text,
    };
  }
}
```

- `AgentBindings.AGENT` is **TRANSIENT**: each injection wraps the agent
  against the injector's context; a controller's wrapper reads the request's
  `SecurityBindings.USER`. Identity is per-turn, never baked at projection.
- **Quota preflight**: with `MeteringBindings.QUOTA` bound, an over-quota turn
  throws 429 `quota_exceeded` BEFORE the model call spends money; quota is
  consumed post-turn on success.
- **Events**: one `'agent'` event per turn + N `'mcp'` events per tool call,
  sharing the principal and `meta.correlationId` (the turn id). Register the
  hooks via `app.component(MeteringComponent)`.
- **Sessions**: `createSession()` results register in
  `AgentBindings.SESSIONS`; `app.stop()` destroys them all (a leaked harness
  session is a billing cloud sandbox).
- `AgentBindings.RAW_AGENT` = the unwrapped agent (escape hatch — no
  identity, no metering).
- Transport auth always wins: a `REQUEST_AUTH`-authenticated MCP call is
  never overridden by an in-process principal.

## Security posture

Tool results are model inputs — a tool returning untrusted content can steer
the loop (prompt injection). Defaults: read-only/idempotent tools in the
`include` list; per-principal quota as blast-radius limiter; side-effecting
tools wait for approval flows.

## Testing (mock model, no network/key)

```ts
import {MockLanguageModelV4} from 'ai/test';
// doGenerate 1: {type:'tool-call', toolName, input: JSON.stringify(...)}
// doGenerate 2: {type:'text', text:'done'}
```

`examples/hello-agents` is the runnable reference (`pnpm -F hello-agents
start` — deterministic mock model, zero credentials). The cloud-sandbox
`HarnessAgent` path (`@ai-sdk/harness-*` + `@ai-sdk/sandbox-vercel`) is a
manually verified recipe, not CI-covered.

Tested with `ai@7.0.x`. Full guide: `docs/guides/agents.md`; design:
`docs/proposals/harness.md`.
