# @agentback/command

Project your app's registered `@tool` classes as a **command-line interface** —
`my-svc forecast --city Tokyo`. The same Zod schema that already serves REST,
MCP, OpenAPI, and the AI SDK projection becomes the flag surface, and every
invocation routes through the full `MCPServer.callTool` pipeline (validation,
`@authorize` voters, metering, output validation). No `.command()` builder to
learn — the `@tool` **is** the command.

The sixth projection of the one `@tool` surface, and a sibling of
[`@agentback/agents`](../agents/README.md): where `toHostTools` routes an AI SDK
loop through `callTool`, this routes **argv/stdout** through the identical seam.

> **Who it's for.** A **human operator/scripter** running a tool by hand or from
> a shell script, Makefile, or CI step. Agents are already better served by the
> app's stdio MCP surface (typed JSON in, boot-once) — so agent-mode
> (`--format json`) is a bonus here, not the headline. See
> [docs/proposals/cli-projection.md](../../docs/proposals/cli-projection.md).

## Install

```bash
pnpm add @agentback/command
# optional, only for --format toon:
pnpm add @toon-format/toon
```

## Quickstart

Your app already has the hard part — registered `@tool` classes. Add a `bin`:

```ts
#!/usr/bin/env node
import {buildCli} from '@agentback/command';
import {createApp} from './app.js'; // your existing AgentBack app factory

const app = await createApp();
await app.start(); // REQUIRED before invoking (see Lifecycle)
const run = await buildCli(app, {include: ['forecast', 'geocode']}); // least privilege
try {
  process.exitCode = await run(process.argv.slice(2));
} finally {
  await app.stop();
}
```

```bash
$ my-svc forecast --city Tokyo --days 3
{ "city": "Tokyo", "days": 3, "tempC": 21, "summary": "clear" }

$ my-svc forecast --help          # flags derived from the tool's Zod input
$ my-svc --llms                    # machine-readable manifest of the selected tools
```

## How argv becomes a validated call

`argvToBundle` maps each top-level key of the tool's `input:` schema to a
`--flag`, then **coerces** each string argv value off the emitted JSON Schema
type before `callTool` re-validates with the tool's own Zod. This matters: your
`@tool` inputs are authored `z.number()`/`z.boolean()` for typed JSON bodies —
argv delivers strings, so the adapter coerces `"3"` → `3` rather than letting
Zod reject it.

- Booleans are flags: `--verbose` (true), `--no-verbose` (false).
- Arrays repeat: `--tag a --tag b` → `['a','b']`.
- Mark a field `z.string().meta({positional: true})` to make it a **positional
  arg** (`my-svc geocode "Mt Fuji"`) instead of `--query`.
- A **streaming** (`streamOf`/async-generator) tool emits **NDJSON**, one item
  per line, incrementally.

## Output & errors

- **Success is the tool's bare, output-validated result** — the same body the
  REST route returns. The process **exit code** carries success/failure (read
  `$?`), so there is no `{ok, data}` wrapper.
- **Errors** print an `AgentError`/`ErrorCodes` envelope to **stderr** and exit
  non-zero. A plain `Error` is redacted to a generic 500 — its message never
  leaks (same contract as REST/MCP).
- **`--format text|json|toon`** — default is chosen by the stdout TTY (`text`
  at a terminal, `json` when piped). No `CI`/product-name env sniffing.

## Identity

A CLI has no transport, so there is one **local principal** (`buildCli(app,
{principal})`). `@authorize`-guarded tools authorize under it and metering
attributes to it. Omit for the anonymous/local default.

## Lifecycle

Tool discovery (`buildCli`) works before `app.start()`, but **invocation needs a
started app** — DB pools, config, and messaging initialize in lifecycle
observers, and `app.stop()` is a no-op without `start()`. Your `bin` owns
`start()`/`stop()` (see Quickstart). This pays observer startup per invocation;
that is the honest cost of a per-process CLI.

## Not in scope

`confirm:` tools (excluded, parity with `@agentback/agents`), nested subcommand
trees, and interactive prompts. See the proposal's "NOT in scope". Positional
args and incremental `streamOf` streaming shipped in v1.1.

## Exports

- `buildCli(app, opts)` → `CliRunner` — the whole thing.
- `argvToBundle(argv, jsonSchema?)` — the argv→typed-bundle adapter.
- `serializeResult` / `serializeError` / `OutputFormat`, `detectFormat`.
- `usage` / `toolHelp` / `renderLlms` — the discovery surface.

Selection (`include`/`exclude`/`scopes`) is shared with `@agentback/agents` via
`selectTools` in `@agentback/mcp`. Example: [examples/hello-command](../../examples/hello-command).
