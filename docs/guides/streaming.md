# Guide: Typed streaming (SSE & JSONL)

Stream events from a route with the same schema discipline as a unary
response: a per-item Zod schema on the decorator, per-item validation on the
wire, a typed `for await` on the client, and the item schema projected into
`/openapi.json`. By the end you'll have an SSE route, a JSONL variant, a
typed client consumer, and the same generator streaming progress over MCP.

> Prerequisites: [Build a REST API](build-a-rest-api.md) and
> [Schema-first decorators](../concepts/schema-first-decorators.md).
> Working example: [`examples/hello-rest`](../../examples/hello-rest)'s
> `GET /greet/stream/{name}` (`curl -N` to watch).
> Design rationale: [proposal P0-2](../proposals/p0-2-typed-streaming.md).

## 1. Declare a stream route with `streamOf`

`streamOf:` replaces `response:` for routes that emit a sequence. The handler
must return an `AsyncIterable` of the item type — an async generator is the
natural shape — and the decorator enforces that at compile time, with the
same precision `response:` gives unary routes.

```ts
import {z} from 'zod';
import {api, get} from '@agentback/openapi';

export const OrderPath = z.object({id: z.string().min(1)});
export const OrderEvent = z.object({
  id: z.string(),
  status: z.enum(['queued', 'picking', 'shipped', 'delivered']),
  at: z.string(),
});

@api({basePath: '/orders'})
export class OrderEventsController {
  @get('/{id}/events', {path: OrderPath, streamOf: OrderEvent})
  async *events(input: {
    path: z.infer<typeof OrderPath>;
  }): AsyncGenerator<z.infer<typeof OrderEvent>> {
    for await (const e of this.orderEvents.watch(input.path.id)) {
      yield e;
    }
  }
}
```

Rules the decorator enforces at decoration time:

- `streamOf` and `response` are mutually exclusive — a stream route has
  exactly one success shape, the item schema.
- `streamOf` and `idempotency` are mutually exclusive — a stream cannot be
  replayed from a cache.

### Wire format: SSE (default) or JSONL

`format: 'jsonl'` switches the wire format; nothing else changes — the
handler, the schema, and the error contract are identical.

```ts
@get('/{id}/events.jsonl', {path: OrderPath, streamOf: OrderEvent, format: 'jsonl'})
```

| Format            | Content-Type        | Item frame               | Terminal error frame                 |
| ----------------- | ------------------- | ------------------------ | ------------------------------------ |
| `'sse'` (default) | `text/event-stream` | `data: <JSON>\n\n`       | `event: error` + `data: {"error":…}` |
| `'jsonl'`         | `application/jsonl` | one JSON object per line | a `{"error":{…}}` line               |

Both formats carry the same error payload
(`{statusCode, code, message, details?}`), so clients share one error
contract regardless of format.

## 2. The runtime contract

`RestServer.sendStream` runs one pull/validate/cleanup loop for both formats
(only the framing differs). The behaviors worth designing around:

**The first item is pulled before headers are flushed.** An error thrown
before the first `yield` (auth failure, not-found) still surfaces as a normal
HTTP error with the right status code. The trade-off: the response doesn't
commit until the first item, so a slow producer should yield something
promptly (an initial snapshot or `{status: 'connected'}`-style item).

**Every item is validated against `streamOf` before it's written.** An item
that fails validation terminates the stream with a terminal error frame — a
stream that lies about its item type must not keep lying.

**Mid-stream errors use the same envelope as unary errors.** Once headers are
flushed the status code can't change (inherent to streaming), so a handler
throw becomes a terminal error frame built by `buildErrorEnvelope`. The usual
[error rules](../concepts/errors.md) apply unchanged: a plain `Error` is
redacted to a generic 500 `internal_error` — its message never reaches the
caller; throw an `AgentError` (from `@agentback/openapi`) when the message
should.

**Client disconnect releases your resources.** When the client goes away, the
server calls the iterator's `return()`, so a generator's `finally` block (or
a `try`/`finally` around the loop) is the place to unsubscribe from upstream
sources:

```ts
async *events(input: {path: z.infer<typeof OrderPath>}) {
  const sub = this.orderEvents.subscribe(input.path.id);
  try {
    for await (const e of sub) yield e;
  } finally {
    sub.close(); // runs on client disconnect too
  }
}
```

Note the exception: on a `resumable:` route the disconnect does **not** call
`return()` — see [§7](#7-resumable-streams-sse).

**A slow reader pauses the producer.** The next item is pulled only when the
transport can take more: the Express loop waits for the socket's `drain`, and
the Web path is a pull-based `ReadableStream`, so a client that stops reading
stops your generator at its next `yield` instead of every item piling up in
server memory. The same holds on every host (Express, web dispatch, the native
listener) and for an attached `resumable:` reader. Nothing to configure — but
it means a producer that must keep pace with an external source should buffer
or drop on its own side.

**`app.stop()` ends open streams.** A stream has no natural end, so a graceful
stop would wait on it forever. Instead `stop()` ends every connected stream
cleanly (the client sees EOF) and aborts the handler's
`CoreBindings.ABORT_SIGNAL` with `AbortReasons.CANCELLED` — distinct from
`CALLER_GONE`, which a hangup produces. Ordinary requests still drain
gracefully.

**Heartbeats defeat idle proxies (SSE only).** Configure
`{rest: {sse: {pingMs: 15_000}}}` to write `: ping` comment lines on an
interval. Off by default; JSONL has no comment-line convention, so the
setting is ignored for `'jsonl'` routes.

## 3. Consume with the typed client

`@agentback/client`'s `defineRoute` takes the same `streamOf` (and `format`)
keys; `route.stream(...)` yields items validated against the shared schema.
Share the schema module with the server — same pattern as
[unary routes](build-a-hybrid-app.md#a-type-safe-client-with-no-codegen).

```ts
import {createClient, defineRoute} from '@agentback/client';
import {OrderEvent, OrderPath} from './schemas.js';

const orderEvents = defineRoute('GET', '/orders/{id}/events', {
  path: OrderPath,
  streamOf: OrderEvent,
});

const client = createClient({baseURL: 'http://localhost:3000'});
const ac = new AbortController();

for await (const e of orderEvents.stream(
  client,
  {path: {id: 'o-42'}},
  {signal: ac.signal},
)) {
  console.log(e.status); // typed as the OrderEvent union
  if (e.status === 'delivered') ac.abort();
}
```

- Each event is validated against `streamOf`; a mismatch throws a
  `ClientError` carrying the Zod issues.
- A terminal error frame (SSE `event: error` / JSONL error line) throws a
  `ClientError` carrying the server's error payload.
- Abort via `options.signal`; the server sees the disconnect and runs your
  generator's cleanup.
- The parser is browser-safe (Web Streams + `TextDecoder`, no Node APIs).

## 4. What OpenAPI sees

The item schema is emitted on the `200` response under the stream media type
as `x-itemSchema`:

```yaml
responses:
  '200':
    content:
      text/event-stream:
        x-itemSchema: {type: object, properties: {id: {type: string}, …}}
```

The `x-` prefix is deliberate: the document is OpenAPI 3.1.1, and a bare
`itemSchema` key is only valid from OpenAPI 3.2 — a framework whose thesis is
boundary coherence must not serve an invalid `/openapi.json`. The key is
promoted to `itemSchema` when emission moves to 3.2.

## 5. The same generator over MCP

Streaming metadata is transport-neutral. A dual REST + MCP class (see
[Build a hybrid app](build-a-hybrid-app.md)) can expose the same async
generator as a `@tool`: invoked over MCP, the iterable is **drained** — each
yielded item is relayed as an MCP progress notification (when the caller sent
a `progressToken`), and the collected items become the tool result. Declare
`output:` as the **collected** shape, typically `z.array(Item)`:

```ts
@get('/{id}/events', {path: OrderPath, streamOf: OrderEvent})
@tool('order_events', {input: OrderPath, output: z.array(OrderEvent)})
async *events(input: {path: z.infer<typeof OrderPath>}) { … }
```

One generator, three consumers: an SSE/JSONL HTTP stream, a typed client
`for await`, and an MCP tool with live progress.

## 6. Bring your own stream library

The contract is the platform type, `AsyncIterable` — not a framework stream.
Anything that produces one plugs in at the return boundary, and the framework
takes no dependency on it. Effect:

```ts
import {Stream} from 'effect';

@get('/ticks', {streamOf: Tick})
async ticks() {
  const ticks = Stream.fromSchedule(…).pipe(/* Effect-land */);
  return Stream.toAsyncIterable(ticks); // back to the platform type
}
```

(`Stream.toAsyncIterable` takes a requirement-free stream; if yours carries a
requirements channel, satisfy it first or use `Stream.toAsyncIterableWith`.)

RxJS:

```ts
import {eachValueFrom} from 'rxjs-for-await';

@get('/ticks', {streamOf: Tick})
async ticks() {
  return eachValueFrom(this.ticks$);
}
```

Whatever produced the iterable, the boundary guarantees hold: every item is
validated against `streamOf`, errors are framed by the shared contract (map
domain failures to `AgentError` if the message should reach the caller), and
client disconnect propagates as the iterator's `return()` — Effect and RxJS
both translate that into their own cancellation/unsubscription.

## 7. Resumable streams (SSE)

By default a dropped connection ends the work: the server calls `return()` on
your generator and the client that comes back starts from nothing. For a cheap
stream that is the right trade. For an expensive one — an agent turn a user
is paying for — a browser refresh should not cost the generation.

Opt in per route:

```ts
@get('/turns/{id}/events', {
  path: TurnPath,
  streamOf: TurnEvent,
  resumable: {windowMs: 30_000, maxEvents: 1024},
})
async *events(input: {path: z.infer<typeof TurnPath>}) { … }
```

Every frame now carries an `id:`. A browser needs no client code at all —
`EventSource` remembers the last id it saw and replays it as `Last-Event-ID`
on reconnect:

```ts
new EventSource('/turns/abc/events'); // resumes by itself after a drop
```

What changes on the server:

- **The producer survives the disconnect.** Your generator keeps running for
  `windowMs` (default 30s), buffering into a ring of `maxEvents` (default
  1024). The handler is **not** re-invoked on reconnect — the client
  re-attaches to the same in-flight generator and is replayed only what it
  missed.
- **`CoreBindings.ABORT_SIGNAL` follows the stream, not the socket.** This is
  the deliberate inversion of the usual [cancellation](../concepts/cancellation.md)
  rule: a `resumable:` route's signal fires when the window closes (reason
  `RESUME_WINDOW_CLOSED`) or the server stops (`CANCELLED`), never merely
  because the client blinked — otherwise the feature would defeat itself. A
  stream that completes normally does not abort it.
- **You pay for the window.** Between the disconnect and the window closing
  you are running work nobody is reading — that is the whole cost of the
  feature, and why it is opt-in and bounded on both time and memory.
- **A resume that cannot be honoured is a 409, never a fresh run.** An
  unknown or expired stream id, a position the ring has already discarded,
  or an id from another route or principal all get the same HTTP 409
  (`code: 'conflict'`) error envelope — a probe cannot tell them apart.
  `EventSource` fails the connection on a non-200 and stops reconnecting, and
  the handler is not re-run: a request carrying a well-formed
  `Last-Event-ID` never starts a new stream. (An unparseable one is ignored
  and starts fresh.) To start over, open a new stream without the header.
- **A stream is bound to its route and principal.** The resume must arrive on
  the route that opened the stream, as the same principal. On an
  **unauthenticated** route there is no principal, so the stream id — an
  unguessable UUID, echoed on every frame — is a **bearer capability**: anyone
  holding it can read the rest of the stream. Authenticate the route if that
  is not acceptable.
- **Live streams are capped server-wide.** At most
  `rest.resumable.maxLiveStreams` (default 1000) streams are live at once.
  Past the cap a **new** stream is refused with HTTP 503 + `Retry-After`
  before the handler runs; resuming a live stream is never refused by the
  cap.

  ```ts
  new RestApplication({rest: {resumable: {maxLiveStreams: 200}}});
  ```

Two constraints worth knowing:

- **SSE only.** `format: 'jsonl'` has no frame-id convention, so the
  combination is refused at decoration time.
- **Single process.** The buffer is in memory, so a client that reconnects to
  a different instance gets the unknown-stream 409 — the same trade
  `InMemoryEventStore` makes in `@agentback/mcp-http`. Behind a load
  balancer, use sticky sessions.

## Out of scope (today)

- **WebSockets** — SSE/JSONL covers the dominant request→stream case;
  bidirectional transport is a separate proposal.
- **Durable / cross-instance resumption** — `resumable:` is per-process
  (see §7). A shared-store implementation is a separate change.
