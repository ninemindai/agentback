# Agent Console Dock (`@agentback/console-chat`)

An **ACP agent dock** added to the unified developer console (`/console`): a
right-column chat panel that greets a coding agent with the live app's full
context — bindings, schema, routes, tools — and lets you drive source evolution
from within the console.

Two verbs: **see** (agent reads the live app via `IntrospectionTools`) and
**evolve** (agent edits source files under the ACP permission model).

## When to use

- You want a coding agent **embedded in the console** to answer questions about
  _this running app_ and optionally edit its source.
- You already have `@agentback/introspection` wired and want to close the loop
  by adding the conversational front-end.
- You are on a Node host (`RestApplication`) — this package is **unavailable**
  on `EdgeRestApplication`.

## Wiring

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {IntrospectionTools} from '@agentback/introspection';
import {installConsole, defaultFeatures} from '@agentback/console';
import {chatConsoleFeature} from '@agentback/console-chat';

const app = new RestApplication();
app.component(MCPComponent);
app.service(IntrospectionTools);
await installMcpHttp(app);

const chat = chatConsoleFeature({
  enabled: true,
  introspection: true,   // ground the session via IntrospectionTools
});

await installConsole(app, {
  features: [...defaultFeatures(), chat],
  unsafeAllowUnauthenticated: true, // local dev only
});

await app.start();
// Console at /console — dock appears when claude-agent-acp is on PATH.
```

## Agent discovery

The dock probes for ACP agents on `PATH` using the built-in catalog (seeded
with `claude-agent-acp`). Extend with custom agents:

```ts
chatConsoleFeature({
  enabled: true,
  agents: [
    {id: 'my-agent', name: 'My Agent',
     detect: {bin: 'my-agent'}, command: ['my-agent', '--acp']},
  ],
})
```

Install the pinned reference adapter:

```bash
npm install -g claude-agent-acp
```

The dock's **Doctor (F1)** shows the exact install line when the binary is
missing or the wrong version — you never need to read the docs to fix it.

## What the agent sees

At session start the bridge injects:
1. The **OKF brief** (`GET /schema-explorer/api/okf`) as standing context.
2. The app's **`/mcp` endpoint** as an HTTP MCP server (business tools + the
   `IntrospectionTools` `inventory`/`get`/`get_okf_bundle` surface).

The introspection surface is **read-only forever**: the agent queries it but
never calls routes or tools through it. Evolution = source edits (the agent's
native ACP capability).

## Navigation focus

Each explorer panel can publish a structured focus descriptor:
`{kind: 'schema-entity'|'binding'|'route'|'tool', id, label?}`. The dock
subscribes and renders a dismissible chip above the composer; the next message
attaches the chip as an ambient context block so `get({kind, id})` is the
natural next call.

## Security posture

- **Off by default.** No bridge endpoints register unless `enabled: true`.
- **Dock hidden unless >=1 agent discovered.** The picker only shows present
  agents; zero discovered = dock absent.
- **All endpoints behind console `auth` middleware.** Sessions require an
  authenticated principal (`SecurityBindings.USER`); `401` otherwise.
- **Loopback-only without real auth.** `unsafeAllowUnauthenticated: true` is a
  local-dev escape hatch. Do not expose to a non-loopback interface without a
  real `auth` handler.
- **Permission prompts are not bypassable.** File edits and shell commands
  always reach the user. The "remember" scope is path + current session only —
  never a blanket "always allow."
- **ACP is adapter-isolated.** All protocol glue is in `acp-session.ts`; SDK
  churn touches one file.

See `docs/guides/agent-console.md` for the complete security guide and
threat model.

## Dependency note

`@agentback/console` does NOT import `@agentback/console-chat` at the server
level. `installConsole` reads the `chatConfig` property off the feature via
duck-typing to avoid the circular dep. `chatConsoleFeature()` is both a
`ConsoleFeature` and a `{chatConfig: ConsoleChatConfig}` — the extra property is
the out-of-band channel.
