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
pnpm -F hello-mcp-events test    # the whole loop, in process
pnpm -F hello-mcp-events start   # MCP at http://127.0.0.1:3000/mcp
```

The test uses a stub transport as the receiver: it echoes the verification
challenge and records each delivery, which it checks with
`verifyWebhook(secret, headers, body)`.

To try it against ChatGPT, expose the server over `https` (a tunnel), replace
the demo strategy with real OAuth (`installMcpHttp({auth})`), and walk OpenAI's
MCP Events testing checklist. The callback URL ChatGPT registers must be
publicly routable: the default transport refuses private and loopback
addresses, and checks again at every connection.
