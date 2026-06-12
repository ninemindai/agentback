# Proposal P1-3: MCP Suite Completion — Host Aggregation Parity + Request Extras

**Status:** Implemented (2026-06-10).
**Packages touched:** `mcp-host`, `mcp`.

## Motivation

The MCP suite is the framework's widest moat, but two gaps undercut the
"gateway" and "rich tool" stories:

1. `mcp-host` aggregates **tools only** — the SDK `Server` it builds declares
   `{capabilities: {tools: {}}}` and registers no resource/prompt handlers
   (`packages/mcp-host/src/index.ts:113-131`). A gateway that drops
   upstream resources/prompts is not a gateway.
2. Tool handlers can inject `REQUEST_AUTH`/`REQUEST_INFO`, but have no access
   to the per-request SDK extras — so **progress notifications, elicitation,
   and sampling** (all supported by `@modelcontextprotocol/sdk` 1.29) are
   unreachable from `@tool` methods.

## Part A: `mcp-host` resources + prompts

- Capabilities: declare `resources` and `prompts` when ≥1 upstream exposes
  them (probe `client.getServerCapabilities()` after connect; the
  `RemoteSource.manifest()` pattern in `mcp-connect` already does the
  capability-guarded listing — reuse the approach).
- **Prompts**: aggregate like tools — prefix `upstream__name` (same
  `prefix` option), `prompts/list` merges, `prompts/get` strips the prefix
  and proxies to the owning upstream.
- **Resources**: URIs cannot be prefixed (they're opaque identifiers clients
  pass back verbatim). Instead the host keeps a routing map
  `uri → upstream` built from `resources/list`; `resources/read` routes by
  exact URI. Collisions (two upstreams listing the same URI) **throw at
  connect** — consistent with the existing tool-collision behavior, which
  throws (`mcp-host/src/index.ts:104-108`); an ambiguous gateway is a
  misconfiguration, not a warning. Resource **templates** are listed
  pass-through; reads for template-expanded URIs route by longest-matching
  template owner.
- `resources/list` and `prompts/list` re-query upstreams per request (no
  cache) in phase 1 — matching how `tools` are cached at connect is a
  follow-up once subscriptions land.
- Out of scope: `resources/subscribe` passthrough, `listChanged`
  notifications fan-in (needs upstream notification plumbing; tracked, not
  blocking).

## Part B: request extras for `@tool` methods

Bind the SDK's `RequestHandlerExtra` into the per-request context.
**Depends on P0-1's per-request context guarantee** — today the child
context is created only conditionally in the HTTP handler closure
(`mcp.server.ts:365-374`), and `dispatchTool`/`callTool` default to the
shared app context; P0-1 step 0 makes the child context unconditional.
Additionally, `MCPBindings.PROGRESS` gets a **no-op default bound at the app
level** so tools injecting it never hit a `ResolutionError` on entry paths
without extras (inspector, direct `callTool`):

```ts
MCPBindings.REQUEST_EXTRA; // raw RequestHandlerExtra (escape hatch)
MCPBindings.PROGRESS; // (progress: {progress, total?, message?}) => Promise<void>
```

- `PROGRESS` is a no-op function when the caller sent no `progressToken`
  (tool code never branches); otherwise it relays
  `notifications/progress` via `extra.sendNotification`.
- Elicitation/sampling: rather than wrapping the full client-capability
  negotiation now, `REQUEST_EXTRA` exposes `extra` (which carries
  `sendRequest`) so advanced tools can call `elicitation/create` /
  `sampling/createMessage` through the SDK types. First-class
  `MCPBindings.ELICIT` sugar is a follow-up once we have a real consumer.

```ts
@tool('reindex', {input: ReindexIn})
async reindex(input: …, @inject(MCPBindings.PROGRESS) progress: Progress) {
  for (const [i, batch] of batches.entries()) {
    await this.index(batch);
    await progress({progress: i + 1, total: batches.length});
  }
}
```

This also creates the seam P0-2's follow-up needs: a `streamOf` generator
exposed as a tool can pump items through `PROGRESS` without new metadata.

> **Status (shipped):** the stream-tools bridge is implemented in
> `packages/mcp` (`MCPServer.invokeTool`). A `@tool` returning an async
> iterable is drained — each item relayed via `PROGRESS`, the collected array
> returned as the result (`output:` describes the collected shape). See the
> "Streaming tools" section in `packages/mcp/README.md`.

## Implementation plan

1. `mcp`: bind `REQUEST_EXTRA` + `PROGRESS` in the per-session handler
   closures (`registerAllOn`'s handler already receives `extra`); unit tests
   for both (progress relayed with token, no-op without).
2. `mcp-host`: prompts aggregation (mirror tools code path), resource routing
   map + read proxy, capability probing; tests with two fake upstreams
   (in-memory transports) covering prefixing, URI collision, template routing.
3. README updates for both packages.

## Out of scope

- Resource subscriptions / listChanged fan-in (above).
- CIMD / Cross-App Access in `mcp-http` — auth-spec currency is its own
  proposal once the 2025-11 revision stabilizes in the SDK.
- Authorization on resources/prompts (extends P0-1 after this lands).
