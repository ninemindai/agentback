# {{name}}

An MCP server on [AgentBack](https://agentback.dev) —
decorator-driven tools with Zod input schemas, stdio transport.

```bash
npm install
npm run build && npm start      # stdio MCP server
npm test                        # in-memory MCP session, no process spawn
```

Claude Desktop / Cursor config:

```json
{"mcpServers": {"{{name}}": {"command": "node", "args": ["dist/main.js"]}}}
```

## Upgrading

```bash
npm run update -- --dry-run   # report what would change, write nothing
npm run update                # bump @agentback/* and run migrations
```

Releases are lockstep, so the migrations for a release ship with it — the
script runs `npx @agentback/cli@latest` rather than a locally installed copy.
