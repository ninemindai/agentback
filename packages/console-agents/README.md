# @agentback/console-agents

An **Agent** tab for `/console` that runs one turn of **your app's own agent**
against **your app's own tools**, in the running process.

```ts
import {installAgent} from '@agentback/agents';
import {installConsole, defaultFeatures} from '@agentback/console';
import {agentsConsoleFeature} from '@agentback/console-agents';

installAgent(app, {agent: myAgent});
await installConsole(app, {
  auth: {/* … */},
  features: [...defaultFeatures(), agentsConsoleFeature({enabled: true})],
});
// → /console/#/agents
```

Runnable with **no API key and no network**:
`pnpm -F hello-agents console`.

## Not the chat dock

`@agentback/console-chat` also puts an agent in the console. They are different
things and both are useful:

|                 | `console-chat` (dock)               | `console-agents` (this)       |
| --------------- | ----------------------------------- | ----------------------------- |
| Whose agent     | a **coding** agent (Claude Code, …) | **yours**, via `installAgent` |
| What it acts on | your **source tree**, over ACP      | your **`@tool`s**, in-process |
| Where it runs   | a spawned subprocess                | this process's DI container   |
| The point       | evolve the app                      | see the app work              |

The dock writes the code; this runs what the code produced. Edit in the dock,
exercise here.

## Why the turn runs on the server

A model call needs a provider credential, and anything in a page bundle is
published. So the browser only ever sends a prompt string — the key stays in the
server environment `installAgent` already reads.

The panel resolves `AgentBindings.AGENT` **per request**, which means a turn goes
through the same wrapper production uses: quota preflight, per-turn identity from
`SecurityBindings.USER`, metering events. There is no console-only agent path
that could drift from the real one.

## Off by default

This panel **executes**. A turn spends tokens and invokes real tools with real
side effects, as the console operator. So:

- `enabled` defaults to `false`; when off, no route is mounted at all — not
  merely hidden in the UI.
- The console's auth gate covers its endpoints like every other panel's.
  `installConsole` refuses to mount without a stated auth posture.
- Enabling this on a publicly reachable console hands strangers your tools and
  your provider bill. Keep the console behind real auth or on loopback.

The page is statically bundled into the console SPA, so it is always _present_.
Without the feature enabled — or with no agent bound — it renders an explanation
of what to turn on instead of a prompt box.

## API

| Export                             | Purpose                                    |
| ---------------------------------- | ------------------------------------------ |
| `agentsConsoleFeature(config?)`    | The `ConsoleFeature` to pass to `features` |
| `AgentPlaygroundController`        | The REST controller (register it yourself) |
| `TurnIn` / `TurnOut` / `StatusOut` | Zod schemas for the two endpoints          |

`GET /console/agents/api/status` → `{available, tools}` (drives the empty state).
`POST /console/agents/api/turn` with `{prompt}` → `{text, steps}`.

`steps` is flattened to what the panel renders: what the model said, and which
tools it called with what. Anything deeper belongs in a trace backend, not a dev
console.

## Layering

Depends on `@agentback/agents` (for `AgentBindings`), `rest`, `openapi`, `core`.
It does **not** import `ai` — `@agentback/agents` loads that lazily, so the
console does not pull the AI SDK into apps that have no agent.
