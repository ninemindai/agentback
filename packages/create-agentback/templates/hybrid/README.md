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
