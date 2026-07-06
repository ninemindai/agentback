# hello-agents

The magical moment: a Vercel AI SDK agent calls the `@tool` classes you already wrote — zero re-declaration. One Zod schema is the validator, the `z.infer` type, the OpenAPI/MCP contract, **and** the agent's tool.

```bash
pnpm build
pnpm -F hello-agents start
```

No API key, no network — a deterministic mock model drives the loop:

```
Agent answer: Tokyo is 21°C with clear skies.

Steps (the magical moment — YOUR @tool, called by the agent):
  → forecast({"city":"Tokyo"})
  ← {"city":"Tokyo","tempC":21,"summary":"Clear skies"}
```

What it shows:

- `toHostTools(app, {include: ['forecast']})` — the app's registered `@tool` projected as an AI SDK host tool through the full `MCPServer.callTool` pipeline (validation, authorization, metering, output validation). Least-privilege `include` list; typos throw at projection time.
- `new ToolLoopAgent({model, tools})` — the loop is the AI SDK's; AgentBack wires what surrounds it.
- `installAgent(app, {agent})` + `AgentBindings.AGENT` — DI injection, per-turn identity, session lifecycle on `app.stop()`.

Swap `mockForecastModel()` in `src/main.ts` for a real provider (`pnpm add @ai-sdk/anthropic`, `anthropic('claude-sonnet-4-5')`, `ANTHROPIC_API_KEY`) — the AgentBack side is identical.

Guide: [docs/guides/agents.md](../../docs/guides/agents.md) • Package: [@agentback/agents](../../packages/agents/README.md)
