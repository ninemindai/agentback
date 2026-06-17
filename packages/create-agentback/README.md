# create-agentback

Scaffold a new [AgentBack](https://agentback.dev) service — a REST API, an MCP
server, or both from one process — with one command. No global install: `npm`,
`pnpm`, `yarn`, and `bun` all run it via their `create` shortcut and the
generated app's "next steps" are printed in whichever package manager you used.

```bash
npm create agentback my-service
pnpm create agentback my-service
```

That scaffolds the `hybrid` template (REST + MCP) into `my-service/`. Then:

```bash
cd my-service
pnpm install
pnpm build && pnpm start
```

## Templates

Pick one with `--template` (default `hybrid`):

| Template | What you get                                                           |
| -------- | ---------------------------------------------------------------------- |
| `hybrid` | REST **and** MCP from one DI container — one controller, two surfaces  |
| `rest`   | REST only, with `/openapi.json` and Swagger UI at `/explorer`          |
| `mcp`    | MCP server over stdio (wire into Claude Desktop / Cursor as a command) |

```bash
npm create agentback my-api -- --template rest
pnpm create agentback my-api --template rest
```

> **`npm` needs `--`** before flags (it forwards everything after `--` to the
> scaffolder). `pnpm`/`yarn`/`bun` pass flags through directly, so no `--`.

## Capabilities

Add runnable integrations at scaffold time. Each flag pulls in the dependency,
wires it into `application.ts`, and drops a working example you can run or
delete.

| Flag        | Templates    | Adds                                                  |
| ----------- | ------------ | ----------------------------------------------------- |
| `--drizzle` | all          | Example `users` table + store + REST route / MCP tool |
| `--auth`    | rest, hybrid | JWT login + a `@authenticate('jwt')`-protected route  |
| `--console` | rest, hybrid | Unified dev console at `/console`                     |

```bash
npm create agentback my-api -- --template hybrid --drizzle --auth
pnpm create agentback my-api --template hybrid --drizzle --auth
```

You can also list them with `--with`:

```bash
pnpm create agentback my-api --with drizzle,auth
```

Capabilities are validated against the template — `--auth`/`--console` need an
HTTP server, so they're rejected for the stdio `mcp` template.

- **`--drizzle`** scaffolds the single-source-of-truth chain: one Drizzle table
  feeds `drizzle-zod`, and the resulting Zod schemas drive the row type, the
  runtime validator, the OpenAPI document, and the MCP tool schema. It ships an
  **in-memory store** so the app runs and tests pass with no database; set
  `DATABASE_URL` and swap in a Postgres-backed store when you're ready (see
  [`@agentback/drizzle`](../drizzle/README.md)).
- **`--auth`** wires `@agentback/authentication-jwt`: a public `POST /auth/login`
  that issues a token and a protected `GET /auth/me`. It uses a dev signing
  secret by default — set `JWT_SECRET` before deploying.

## HTTP host options (rest, hybrid)

Bake the REST server's bind config into the scaffolded `application.ts`:

```bash
npm create agentback my-api -- --port 8080 --host 0.0.0.0 --base-path /api
```

| Flag          | Default     | Notes                                         |
| ------------- | ----------- | --------------------------------------------- |
| `--port`      | `3000`      | Omit to keep the default + runtime `PORT` env |
| `--host`      | `127.0.0.1` | Omit to keep the default + runtime `HOST` env |
| `--base-path` | `/`         | Prefix every route is mounted under           |

Omitted options are left at the framework defaults, so the runtime `PORT`/`HOST`
environment variables still take effect for 12-factor deploys.

## Interactive mode

Run with **no app name** in a terminal to be prompted for everything — name,
template, add-ons, and port:

```bash
npm create agentback
```

### `-i` / `--interactive` — prompt for the gaps

Pass `-i` to force the prompt flow while supplying some answers up front. It
**skips any field you already gave on the command line** and prompts only for
the rest:

```bash
# name known → prompts for template, add-ons, port
pnpm create agentback my-api -i

# template + add-ons known → prompts for name and port only
pnpm create agentback -i --template rest --drizzle
```

Passing any capability flag (`--drizzle`, `--with …`) counts as having supplied
the add-ons, so the add-ons prompt is skipped — don't pass cap flags if you want
to pick them interactively. `-i` requires a terminal; it errors instead of
hanging when stdin is a pipe.

## All options

```
Usage:
  npm create agentback <name> [-- --template hybrid|rest|mcp] [options]
  pnpm create agentback <name> [--template hybrid|rest|mcp] [options]

  Run with no name on a terminal for interactive mode.

Options:
  -t, --template <name>   Template: hybrid, rest, mcp (default: hybrid)
  --with <caps>           Comma-separated capabilities: console, drizzle, auth
  --drizzle               Shorthand for --with drizzle
  --auth                  Shorthand for --with auth
  -c, --console           Shorthand for --with console
  --port <n>              REST server port (rest|hybrid)
  --host <h>              REST server host (rest|hybrid)
  --base-path <p>         REST base path (rest|hybrid)
  -i, --interactive       Prompt for any options not given on the command line
  -h, --help              Show this help
```

## See also

- [Package catalog](../../docs/packages.md) — every `@agentback/*` package
- [`docs/agent-ergonomics.md`](../../docs/agent-ergonomics.md) — the design thesis
- The `examples/` directory — `hello-rest`, `hello-mcp`, `hello-hybrid`,
  `hello-drizzle`, and more, each mirroring what a template + capability scaffolds.
