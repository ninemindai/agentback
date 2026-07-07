# Operator CLI (`@agentback/command`)

Project the app's registered `@tool` classes as a **command-line tool** —
`my-svc forecast --city Tokyo` — routed through the same `MCPServer.callTool`
pipeline as REST/MCP (validation, `@authorize`, metering, output validation).
The `@tool` **is** the command; there is no `.command()` builder.

The sixth projection of the one `@tool` surface, and the sibling of
[agents.md](agents.md): `toHostTools` gives the tool to an AI SDK loop, `buildCli`
gives the same tool an argv/stdout surface through the identical seam.

> **Audience: a human operator/scripter**, not agents. An agent already has the
> app's stdio MCP surface (typed JSON in, boot-once), which is strictly better
> than argv for a machine. Agent-mode (`--format json`) is a bonus.
>
> **Not `@agentback/cli`** — that is the `deploy` ops CLI (`agentback deploy …`).

## Wire it (one `bin` file)

```ts
#!/usr/bin/env node
import {buildCli} from '@agentback/command';
import {createApp} from './app.js';

const app = await createApp();
await app.start();                 // REQUIRED before invoking (lifecycle-started deps)
const run = await buildCli(app, {include: ['forecast', 'geocode']}); // least privilege
try {
  process.exitCode = await run(process.argv.slice(2));
} finally {
  await app.stop();
}
```

`buildCli(app, {include?, exclude?, scopes?, principal?})` → `(argv, io?) =>
Promise<number>`. Selection (`include`/`exclude`/`scopes`) is the same
`selectTools` predicate `@agentback/agents` uses. `principal` is the one local
identity the CLI runs as (`@authorize` tools authorize under it).

## The rules that bite

- **Coercion is automatic and necessary.** `@tool` inputs are authored
  `z.number()`/`z.boolean()` for JSON bodies; argv is strings. The CLI coerces
  each value off the emitted JSON Schema before `callTool` re-validates. You do
  **not** need `z.coerce.*` in your schemas.
- **Booleans are flags:** `--verbose` → true, `--no-verbose` → false. Absent →
  the schema default/optional applies.
- **Arrays repeat:** `--tag a --tag b` → `['a','b']`.
- **Positional args:** mark a field `z.string().meta({positional: true})` and it
  becomes a bare arg (`my-svc geocode "Mt Fuji"`) instead of `--query`.
- **Output is the bare result** on stdout (no `{ok,data}` wrapper); the **exit
  code** carries success/failure. Errors print an `AgentError` envelope to
  **stderr** and exit non-zero (a plain `Error` is redacted to a generic 500).
- **`--format text|json|toon`** — default is `text` at a TTY, `json` when piped
  (never sniffs `CI`). `toon` needs the optional `@toon-format/toon` peer dep.
- **Streaming (`streamOf`/async-generator) tools** emit **NDJSON**, one item per
  line, incrementally (via the `callTool` PROGRESS seam) — not one buffered
  array.
- **Discovery:** `my-svc --llms` (manifest of the *selected* tools),
  `my-svc <command> --help` (flags from the schema).
- **Lifecycle:** discovery works pre-`start()`; **invocation needs
  `app.start()`** (and `app.stop()` is a no-op without it). The `bin` owns both.
- **`confirm:` tools are excluded** (parity with `@agentback/agents`).

See `examples/hello-command` and [docs/guides/command.md](../../../docs/guides/command.md).
