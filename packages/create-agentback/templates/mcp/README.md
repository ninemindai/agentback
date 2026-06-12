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
