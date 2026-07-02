# hello-mcp

> The AgentBack MCP path end-to-end: decorator-driven tools over stdio, then the same surface over Streamable HTTP with auth + rate limiting.

Three entry points:

- [`src/server.ts`](src/server.ts) — `MCPApplication` serving `echo`/`add`
  tools (`@mcpServer` + `@tool` with Zod `input` schemas) over the default
  **stdio** transport.
- [`src/http-server.ts`](src/http-server.ts) — the same `@tool` surface
  mounted over the MCP **Streamable HTTP** transport (`installMcpHttp`),
  protected by an api-key auth strategy and per-tool rate limiting.
- [`src/test-client.ts`](src/test-client.ts) — spawns the stdio server with
  the official MCP SDK client and verifies `tools/list` + `tools/call`.

## Run

```bash
pnpm build                    # from the repo root
pnpm -F hello-mcp start       # stdio server (for an MCP host to spawn)
pnpm -F hello-mcp start:http  # HTTP server on POST /mcp
pnpm -F hello-mcp test        # drive the stdio server via the SDK client
```
