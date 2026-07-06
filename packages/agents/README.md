# @agentback/agents

Opt-in [Vercel AI SDK](https://ai-sdk.dev) agent wiring for AgentBack apps: project your registered `@tool` classes as an agent's **host-executed tools** — same Zod schemas, same dispatch pipeline — and run turns with per-turn identity, session lifecycle, and metering.

Not to be confused with `@agentback/actors` (stateful entities behind a stable address) — this package runs AI SDK agent _loops_; actors serialize _state turns_.

## What this package does — and deliberately doesn't

**It wires what surrounds the loop, never the loop itself** (the `@agentback/chat` boundary discipline):

- `toHostTools(app, {include})` — your `@tool` classes as an AI SDK `ToolSet`. Every call routes through `MCPServer.callTool`: Zod validation, `@authorize` voters, metering hooks, output validation. `execute` returns the unwrapped, output-validated result.
- `installAgent(app, {agent})` — DI binding (`AgentBindings.AGENT`, request-aware), session registry destroyed on `app.stop()`, per-turn identity, preflight quota + one `'agent'` usage event per turn.

**You** bring the agent: the model/provider, credentials, instructions, and where turns are exposed (your routes/tools/chat handlers — there is no auto-projected `/agent/run` endpoint).

## Install

```bash
pnpm add @agentback/agents ai @ai-sdk/anthropic   # one provider; others work identically
export ANTHROPIC_API_KEY=...                       # the only credential the golden path needs
```

`ai` is an **optional peer dependency** — loaded lazily by `toHostTools`; an `installAgent`-only consumer never crashes without it.

**Tested with:** `ai@7.0.x`. When an AI SDK major lands, policy is _pin back + patch release_ (see the version matrix in this README's history — never diagnose upstream churn yourself).

## Quickstart: an agent that calls YOUR tools

Your app already has the hard part — registered `@tool` classes:

```ts
import {ToolLoopAgent} from 'ai';
import {anthropic} from '@ai-sdk/anthropic';
import {toHostTools} from '@agentback/agents';

const agent = new ToolLoopAgent({
  model: anthropic('claude-sonnet-4-5'),
  // Least privilege: name the tools the agent gets. A typo'd name throws
  // at projection time (never "the model ignores my tool").
  tools: await toHostTools(app, {include: ['forecast']}),
});

const result = await agent.generate({prompt: 'Forecast for Tokyo?'});
console.log(result.text);
console.log(result.steps); // ← your own @tool, called by the agent, zero re-declaration
```

## Do I need `installAgent`?

Not for a one-off `generate()` — the snippet above is complete. Install when you want DI injection, session lifecycle, or identity/metering:

```ts
import {installAgent, AgentBindings} from '@agentback/agents';

installAgent(app, {agent});

@api()
class TaskController {
  constructor(@inject(AgentBindings.AGENT) private agent: AgentPort) {}

  @post('/tasks', {body: TaskIn, response: TaskOut})
  async run(input: {body: z.infer<typeof TaskIn>}) {
    // The turn runs AS the request's authenticated principal: @authorize'd
    // tools authorize correctly, and usage is attributed per principal.
    const result = await this.agent.generate({prompt: input.body.prompt});
    return {text: result.text};
  }
}
```

`AgentBindings.AGENT` is TRANSIENT: each injection resolves a wrapper against the injector's context, so a controller's wrapper reads the request's `SecurityBindings.USER` and supplies per-turn `toolsContext` (principal + turn id) automatically. `AgentBindings.RAW_AGENT` is the unwrapped escape hatch.

## Identity & metering

- **Per-turn principal:** read from the resolution context per call — never baked at projection time. `@authorize`-guarded tools authorize under it (transport `REQUEST_AUTH` always wins over any in-process principal).
- **Quota preflight:** with `MeteringBindings.QUOTA` bound, a turn is denied (429 `quota_exceeded`) _before_ the LLM call spends money; quota is consumed post-turn on success.
- **Events:** one `'agent'` event per turn + N `'mcp'` events per tool call, sharing `meta.correlationId` (the turn id) and the principal. Streams finalize on completion _and_ abort.

## Errors you might hit

| Error                                     | Cause                                                                               | Fix                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `needs the optional peer dependency 'ai'` | `toHostTools` without `ai` installed                                                | `pnpm add ai`                                                                                        |
| `include/exclude name(s) match no … tool` | typo in the include list                                                            | the message names available tools                                                                    |
| `tool 'x' is a confirm: tool`             | `confirm:` tools are excluded from projection (their round-trip doesn't survive it) | keep it MCP-only; watch the approval-flows design                                                    |
| authorization denied from your own tool   | the turn ran without a principal                                                    | run the turn via the injected `AgentBindings.AGENT` in an authenticated request, or check your voter |

Diagnostics: `DEBUG=agentback:agents:*`.

## Degraded MCP features under host-tool invocation

| MCP feature                 | Under projection                                        |
| --------------------------- | ------------------------------------------------------- |
| `MCPBindings.PROGRESS`      | no-op (streamOf tools still drain; items are collected) |
| `MCPBindings.REQUEST_EXTRA` | `undefined` (no transport)                              |
| elicitation / sampling      | unavailable                                             |
| `confirm:` tools            | excluded from projection                                |

Tools relying on these still run — silently degraded.

## Security posture

Handing an LLM host-executed tools means tool results are model inputs — a tool returning untrusted content can steer the loop (prompt injection). For v1: **read-only/idempotent tools in the `include` list + per-principal quota** as blast-radius limiters. Side-effecting tools should wait for the approval-flows design. `toHostTools(app, {scopes})` applies the same visibility gate as a scoped MCP transport.

## Cloud-sandbox harnesses (level 2 — recipe, manually verified per release)

`HarnessAgent` (Claude Code / Codex / Pi wrapped as runtimes) satisfies the same `AgentPort`; sessions created through the wrapped agent register for `app.stop()` cleanup:

```ts
import {HarnessAgent} from '@ai-sdk/harness/agent';
import {claudeCode} from '@ai-sdk/harness-claude-code';
import {createVercelSandbox} from '@ai-sdk/sandbox-vercel';

installAgent(app, {
  agent: new HarnessAgent({
    harness: claudeCode, // needs sandbox + harness creds
    sandbox: createVercelSandbox({runtime: 'node24', ports: [4000]}),
    tools: await toHostTools(app, {include: ['forecast']}), // host-executed: run in THIS process
  }),
});
```

The `@ai-sdk/harness*` family is experimental and **not** CI-covered here — this path is a recipe, re-verified manually per release.

## Boundary recap

| This package provides             | You provide                            |
| --------------------------------- | -------------------------------------- |
| tool projection (`toHostTools`)   | the agent (model, creds, instructions) |
| DI binding + per-turn identity    | where turns are exposed                |
| session lifecycle on `app.stop()` | streaming shape, approval flow         |
| quota preflight + usage events    | the reply-brain logic                  |

Design doc: [docs/proposals/harness.md](../../docs/proposals/harness.md). Example: [examples/hello-agents](../../examples/hello-agents).
