# {{name}}

A hybrid REST + MCP service on [AgentBack](https://agentback.dev):
one DI container, one set of Zod schemas, two surfaces.

```bash
npm install
npm run build && npm start      # REST + Swagger UI + MCP over HTTP
npm test                        # vitest via @agentback/testing
```

- `src/controllers/greeting.controller.ts` — schemas + routes + tools in one class
- `src/application.ts` — the DI container wiring
- `GET /explorer` (Swagger UI) · `GET /mcp-inspector` · `POST /mcp` (MCP HTTP)

## Your first change

The REST route `POST /greet/echo` and the MCP tool `echo` both call one
function, `echo`, in `src/controllers/greeting.controller.ts`. Change it once
and both callers change.

1. Make `echo` return `{echoed: text.toUpperCase()}`.
2. Run `npm test`. The test that compares the REST answer with the MCP answer
   still passes, because both callers call `echo`.
3. Run `npm run build && npm start`. At the URL that `npm start` prints, open
   the MCP inspector at `/mcp-inspector` and call the `echo` tool with
   `{"text": "hi"}`. Then send the same body to the REST route:

   ```bash
   curl -X POST <url>/greet/echo -H 'content-type: application/json' -d '{"text":"hi"}'
   ```

   Both answer `{"echoed": "HI"}`.

## Upgrading

```bash
npm run update -- --dry-run   # report what would change, write nothing
npm run update                # bump @agentback/* and run migrations
```

Releases are lockstep, so the migrations for a release ship with it — the
script runs `npx @agentback/cli@latest` rather than a locally installed copy.
