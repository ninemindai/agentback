# hello-mcp-events

MCP Events end to end: an MCP client subscribes to `comment.created` for one
document, an `add_comment` tool call emits it, and the subscriber's webhook
gets a signed POST. See the [guide](../../docs/guides/mcp-events.md).

## The shape

All in [`src/events.ts`](src/events.ts):

1. **The event type** — `@event('comment.created', {input, payload, scope})`.
   `input` is what a client subscribes with (`{document_id}`); `payload` is what
   each occurrence carries — a preview and the id `get_comment` takes, not the
   whole comment. The method is the filter: deliver only when it returns
   `true`.
2. **The emit** — `add_comment` injects `MCPBindings.EVENTS` and calls
   `events.emit('comment.created', data, {eventId})` after the write.
3. **The read tool** — `get_comment`, which an agent reacting to the event
   calls for the full record.

[`src/application.ts`](src/application.ts) wires it: `MCPComponent`,
`installMcpEvents` (verification + signed, retried delivery) and
`installMcpHttp` with demo bearer tokens — webhook subscriptions require a
principal.

| Token        | Principal | Scopes      | Sees `comment.created`?  |
| ------------ | --------- | ----------- | ------------------------ |
| `demo-alice` | `alice`   | `docs:read` | yes                      |
| `demo-bob`   | `bob`     | —           | no (scope-hidden)        |
| (none)       | anonymous | —           | no; subscribe → `-32012` |

## Run it

```bash
pnpm -F hello-mcp-events build
pnpm -F hello-mcp-events demo    # watch one event arrive, then exit
pnpm -F hello-mcp-events test    # the whole loop, in process
pnpm -F hello-mcp-events start   # MCP at http://127.0.0.1:3000/mcp
```

`demo` subscribes as `demo-alice`, calls `add_comment`, and prints the signed
POST the receiver got (headers, body, and whether the signature verifies).
The demo and the test use an in-process receiver that echoes the verification
challenge and records each delivery, checked with
`verifyWebhook(secret, headers, body)`.

Against the running server, a client must authenticate to subscribe:

```bash
curl -s http://127.0.0.1:3000/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer demo-alice' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Delivering to a receiver on your own machine needs
`createPinnedTransport({allowPrivateAddresses: true, ca})` — see the guide's
"Seeing an event arrive locally".

To try it against ChatGPT, expose the server over `https` (a tunnel), replace
the demo strategy with real OAuth (`installMcpHttp({auth})`), and walk OpenAI's
MCP Events testing checklist. The callback URL ChatGPT registers must be
publicly routable: the default transport refuses private and loopback
addresses, and checks again at every connection.
