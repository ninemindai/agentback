# Build an operator CLI from your tools

`@agentback/command` turns the `@tool` classes you already have into a
command-line tool a human can run — `my-svc forecast --city Tokyo` — without
writing a second definition. It is the **sixth projection** of the one `@tool`
surface (REST, MCP, OpenAPI, typed client, AI SDK host-tools, and now argv), and
every invocation routes through the same `MCPServer.callTool` pipeline:
Zod validation, `@authorize` voters, metering, output validation.

> **Who it's for.** A human operator or a shell script — not agents. An agent is
> already better served by the app's stdio MCP surface (typed JSON in,
> boot-once). The CLI's value is *reach*: the same tool, runnable by hand.

## 1. You already have the tool

Nothing here is CLI-specific — an ordinary MCP tool class:

```ts
import {mcpServer, tool} from '@agentback/mcp';
import {z} from 'zod';

const ForecastIn = z.object({
  city: z.string().min(1).describe('City name'),
  days: z.number().int().min(1).max(7).default(1).describe('Days ahead'),
});

@mcpServer()
export class WeatherTools {
  @tool('forecast', {description: 'Weather forecast.', input: ForecastIn,
    output: z.object({city: z.string(), days: z.number(), tempC: z.number()})})
  forecast(input: z.infer<typeof ForecastIn>) {
    return {city: input.city, days: input.days, tempC: 18 + input.days};
  }
}
```

## 2. Add a `bin`

```ts
#!/usr/bin/env node
import {buildCli} from '@agentback/command';
import {Application} from '@agentback/core';
import {MCPComponent} from '@agentback/mcp';
import {WeatherTools} from './tools.js';

const app = new Application();
app.component(MCPComponent);
app.service(WeatherTools);

await app.start();  // REQUIRED — see Lifecycle
const run = await buildCli(app, {include: ['forecast']});  // least privilege
try {
  process.exitCode = await run(process.argv.slice(2));
} finally {
  await app.stop();
}
```

```bash
$ my-svc forecast --city Tokyo --days 3
{ "city": "Tokyo", "days": 3, "tempC": 21 }
```

## 3. How argv becomes a validated call

```
  argv                       @agentback/command                 @agentback/mcp
   │  forecast                     │                                 │
   │    --city Tokyo --days 3      │                                 │
   ├──────────────────────────────►│                                 │
   │        argvToBundle(rest, JSON-Schema of ForecastIn)            │
   │          "3"  ──coerce──►  3   (number, per the schema type)    │
   │                              │  callTool('forecast', bundle,    │
   │                              │    {principal, ctx, binding})    │
   │                              ├─────────────────────────────────►│
   │                              │   @authorize → Zod in → method   │
   │                              │   → Zod out (bare result)        │
   │                              │◄─────────────────────────────────┤
   │   serialize(result) → stdout │                                 │
   │◄──────────────────────────────┤                                 │
```

The one piece of new code is `argvToBundle`. Your `@tool` inputs are authored
once for typed JSON (`z.number()`, not `z.coerce.number()`), so the adapter
coerces each string argv value off the tool's **emitted JSON Schema** before
`callTool` re-validates. This is why numeric/boolean flags "just work" without
CLI-aware schemas.

## 4. The ergonomics

| You write | On the command line |
| --- | --- |
| `z.number()` field | `--days 3` (coerced to `3`) |
| `z.boolean()` field | `--verbose` (true) / `--no-verbose` (false) |
| `z.array(...)` field | `--tag a --tag b` → `['a','b']` |
| `z.string().meta({positional: true})` | a bare arg: `geocode "Mt Fuji"` |
| omitted field with `.default()` | the default applies |

- **`--format text\|json\|toon`** — default `text` at a terminal, `json` when
  piped (never sniffs `CI`). `toon` is [Token-Oriented Object
  Notation](https://github.com/toon-format/toon), an optional peer dep for
  token-thrift output.
- **`--help`** on a command lists its flags/arguments from the schema;
  **`--llms`** prints a machine-readable manifest of the selected tools.

## 5. Streaming tools

A tool that is an async generator streams incrementally as **NDJSON** — one item
per line, as it yields — instead of a single buffered array:

```ts
@tool('count', {description: 'Count to n.', input: z.object({to: z.number()})})
async *count(input: {to: number}) {
  for (let n = 1; n <= input.to; n++) yield {n};
}
```

```bash
$ my-svc count --to 3
{"n":1}
{"n":2}
{"n":3}
```

This still routes through `callTool` — the CLI binds a progress handler that
emits each yielded item, then suppresses the collected array.

## 6. Output, errors, and identity

- **Success is the tool's bare result** on stdout — the same body the REST route
  returns. The **exit code** carries success/failure (`$?`), so there is no
  `{ok, data}` wrapper.
- **Errors** print an `AgentError` envelope to **stderr** and exit non-zero. A
  plain `Error` is redacted to a generic 500 — its message never leaks.
- **Identity:** a CLI has no transport, so it runs as one **local principal**
  (`buildCli(app, {principal})`). `@authorize`-guarded tools authorize under it;
  metering attributes to it.

## Lifecycle (the one gotcha)

Tool discovery (`buildCli`) works before `app.start()`, but **invocation needs a
started app** — DB pools, config, and messaging initialize in lifecycle
observers, and `app.stop()` is a no-op without `start()`. Your `bin` owns
`start()`/`stop()`. This pays observer startup per invocation; that is the
honest cost of a per-process CLI.

## Not in scope (v1)

`confirm:` tools (excluded, parity with `@agentback/agents`), nested subcommand
trees, and interactive prompts. See `examples/hello-command` and the design
proposal in [docs/proposals/cli-projection.md](../proposals/cli-projection.md).
