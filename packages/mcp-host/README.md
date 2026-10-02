# @agentback/mcp-host

Turn AgentBack into an MCP **gateway**: connect to several upstream MCP
servers — local stdio child processes (Notion, GitHub, …), remote HTTP
servers, or pre-built transports — merge their **tools, prompts, and
resources** into one surface, and proxy calls to the owning upstream. Expose
the aggregate over any transport, including authenticated over HTTP via
[`@agentback/mcp-http`](../mcp-http).

## Usage

```ts
import {createMcpHost, mcpHostBuilder} from '@agentback/mcp-host';

const host = await createMcpHost({
  upstreams: mcpHostBuilder()
    .stdio('notion', 'npx', ['-y', '@notionhq/notion-mcp-server'])
    .http('weather', 'https://weather.example.com/mcp', {bearerToken: tok})
    .build(),
});

// `host.server` is a standard SDK Server — connect it to any transport:
await host.connect(myTransport); // stdio, in-memory, or a Streamable HTTP transport
// …
await host.close(); // closes the server + all upstream connections
```

| option             | default              | meaning                                         |
| ------------------ | -------------------- | ----------------------------------------------- |
| `upstreams`        | —                    | upstream configs (`http`, `stdio`, or `custom`) |
| `prefix`           | `true`               | prefix tool/prompt names with the upstream name |
| `name` / `version` | `mcp-host` / `0.0.0` | aggregate server identity                       |

The `custom` upstream variant takes a pre-built client `Transport` (e.g. one
side of `InMemoryTransport.createLinkedPair()`) for in-process upstreams.

## Aggregation semantics

Capabilities are probed per upstream after connect
(`client.getServerCapabilities()`); the aggregate declares the
`prompts`/`resources` capability only when at least one upstream advertises
it. `tools` is always declared.

### Tools

Namespaced `<upstream>__<tool>` by default (`prefix: false` to keep original
names). `tools/list` merges all upstreams (cached at connect); `tools/call`
routes to the owning one, preserving the upstream's input schema. Name
collisions **throw at connect**.

### Prompts

Aggregated exactly like tools: names are prefixed `<upstream>__<prompt>`
honoring the same `prefix` option, `prompts/get` strips the prefix and
proxies (arguments pass through). Name collisions **throw at connect**.
`prompts/list` re-queries upstreams per request (no cache).

### Resources

URIs are opaque identifiers clients pass back verbatim, so they are **not**
prefixed. Instead the host builds a `uri → upstream` routing map from each
upstream's `resources/list` at connect; `resources/read` routes by exact URI.
Two upstreams listing the same URI is an ambiguous gateway — a
misconfiguration — and **throws at connect**. `resources/list` and
`resources/templates/list` re-query upstreams per request (no cache).

Resource **templates** are listed pass-through. Reads of template-expanded
URIs route to the upstream whose template matches with the most literal
(non-variable) characters; exact duplicate templates across upstreams throw
at connect. Template matching is a conservative RFC 6570 subset: simple
`{var}` segments match one or more non-`/` characters, `{+var}`/`{#var}`
match across `/`, and other operators (`{?q}`, `{.ext}`, …) are treated like
`{var}`. It exists to route a read to its owner, not to validate URIs.

### Not aggregated (yet)

`resources/subscribe` passthrough and `listChanged` notification fan-in need
upstream notification plumbing — tracked, not blocking.

### Host extensions through the gateway

Tool listings pass through whole — `_meta`, `icons` and `annotations` survive
— so a ChatGPT entrypoint or a Claude widget `domain` on an upstream still
reaches the host. Two more things are relayed:

- **Request `_meta`** (`relayMeta`, default on). Vendor-prefixed keys a
  client sends on `tools/call`, `resources/read` and `prompts/get` —
  `_meta["openai/resource"].path` from a ChatGPT file entrypoint, say — reach
  the upstream. Reserved `io.modelcontextprotocol/*` keys and `progressToken`
  describe this hop and are never forwarded. Pass a key predicate to narrow
  it, or `false` for none.
- **Elicitation** (`relayElicitation`, default on). The gateway declares the
  `elicitation` capability to every upstream and forwards a question
  (`elicit.ask`, a 2026 `confirm:` prompt) to its downstream client, then
  returns the answer.
  - Upstreams are spoken to with automatic version negotiation. A stateless
    2026 upstream asks through multi-round-trip results, and a 2025 session
    upstream sends a real `elicitation/create`. Both reach the same relay.
  - A downstream client that did not declare `elicitation` gets an error
    saying so.
  - With `relayElicitation: false`, upstreams see a client that cannot be
    asked.

Two limitations remain:

1. **Prefixing renames tools that host metadata names.** `openai/settings`'
   `readTool`/`updateTool`, a settings layout's `tool` items and a quick
   action's `target.name` refer to the upstream's own names. With the default
   `<upstream>__` prefix they point at nothing.
2. **Upstream `extensions` / `experimental` capabilities are not
   aggregated**, so `openai/settings` is not advertised by the gateway.

For a server that uses either, expose it directly, or through the gateway with
`prefix: false` (which fixes 1 only). Rewriting host vocabulary inside opaque
`_meta` is deliberately out of scope
([P1-7 §7](../../docs/proposals/host-extensions.md#7-gateway-mcp-host-documented-limitations-g8)).

## Exposing the gateway over HTTP

The aggregated `host.server` is the same `Server` type the SDK transports
accept, so you can connect it to a `NodeStreamableHTTPServerTransport` to re-serve
the merged surface — add OAuth resource-server protection in front exactly as
`@agentback/mcp-http` does for the in-process server.
