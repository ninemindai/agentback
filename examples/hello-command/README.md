# hello-command

A terminal CLI built from `@tool` classes with [`@agentback/command`](../../packages/command/README.md).
`WeatherTools` (`forecast`, `geocode`) is an ordinary MCP tool class — nothing
CLI-specific. `main.ts` wires it into a runnable command.

## Run

```bash
pnpm -F hello-command build

node dist/main.js forecast --city Tokyo --days 3
# { "city": "Tokyo", "days": 3, "tempC": 21, "summary": "clear" }

node dist/main.js forecast --city Kyoto      # --days defaults to 1 (from the Zod schema)
node dist/main.js geocode --query "Mt Fuji"
node dist/main.js forecast --help            # flags derived from the tool's input schema
node dist/main.js --llms                     # machine-readable manifest of forecast + geocode
```

## What it shows

- **One definition, argv surface for free.** `WeatherTools` declares Zod
  `input:`/`output:` once; the CLI derives `--city`/`--days` from it.
- **Coercion.** `--days 3` arrives as the string `"3"`; the CLI coerces it to
  the number the `z.number()` schema expects (authored for a JSON body).
- **Bare result + exit codes.** Success prints the tool's result to stdout;
  a bad flag prints an error envelope to stderr and exits non-zero.
- **Least privilege.** `buildCli(app, {include: ['forecast', 'geocode']})` — the
  CLI exposes only the named tools, and `--llms` reflects exactly that set.
