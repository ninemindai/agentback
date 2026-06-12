# Proposal P0-2: Typed Streaming — SSE Responses as a Schema Boundary

**Status:** Implemented (2026-06-10).
**Packages touched:** `openapi`, `rest`, `client`.
**Related:** [agent-ergonomics.md](../agent-ergonomics.md).

## Motivation

Agents stream. Neither FastAPI (`StreamingResponse` is schema-opaque) nor
NestJS (`@Sse` returns untyped Observables) types their streams. OpenAPI 3.2
(Sept 2025) added `itemSchema` and SSE/JSONL guidance precisely for this.
Extending the decorator contract to streams completes boundary coherence for
the one boundary the thesis doesn't yet cover.

Today `RestServer.sendResult` unconditionally calls `res.json(result)`
(`packages/rest/src/rest.server.ts:240-251`), so streaming is impossible
without subclassing.

## Design

### Decorator surface

New `RouteOptions` field, mutually exclusive with `response`:

```ts
const OrderEvent = z.object({id: z.string(), status: z.string()});

@get('/orders/{id}/events', {path: OrderPath, streamOf: OrderEvent})
async *events(input: {path: z.infer<typeof OrderPath>}):
    AsyncGenerator<z.infer<typeof OrderEvent>> {
  for await (const e of this.orderEvents.watch(input.path.id)) yield e;
}
```

- `streamOf: ZodType` — per-item schema. Declaring both `streamOf` and
  `response` throws at decoration time.
- Type-level: `SuccessReturn<O>` (`operation.decorator.ts:53-82`) gains a
  branch — when `streamOf` is set, the method's return must be
  `AsyncIterable<z.infer<streamOf>>` (async generators satisfy this).
  Wrong item type ⇒ compile error at the decorator line, same precision as
  `response:` today.

### Runtime: SSE writer in `RestServer`

`dispatch` is unchanged (it already returns whatever the method returns;
response validation is skipped when `streamOf` is set). `makeHandler` routes
on the registered schemas:

```
if (schemas.streamOf) → this.sendStream(req, res, result, schemas.streamOf)
else                  → this.sendResult(res, result, successStatus)
```

`sendStream` (new `protected` method, subclassable like `sendResult`):

1. Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
   `Connection: keep-alive`, `X-Accel-Buffering: no`; `res.flushHeaders()`.
2. Guard: if the handler returned a non-AsyncIterable, fall through to
   `sendError` (500, "handler declared streamOf but did not return an
   async iterable").
3. Per item: `streamOf.safeParse(item)`; on success write
   `data: <JSON>\n\n`; on failure emit `event: error` with the issue list
   and terminate the stream (a stream that lies about its item type must not
   keep lying).
4. Client disconnect: `res.on('close')` → call `iterator.return?.()` so the
   generator's `finally` blocks run and upstream resources are released.
5. Handler throw mid-stream: emit `event: error` with the framework error
   shape (`{error: {statusCode, message}}`), then end. Status code cannot
   change after headers are flushed — this is inherent to SSE.
6. Optional heartbeat: `RestServerConfig.sse?: {pingMs?: number}` writes
   `: ping\n\n` comments to defeat idle proxies. Default off.

Errors thrown **before** the first `yield` still surface as normal HTTP
errors: the async generator doesn't begin executing until first iteration, so
`sendStream` pulls the first item inside a try/catch before flushing headers.
This gives correct 4xx/5xx for immediate failures (auth, not-found).
Trade-off: headers are delayed until the first item; slow producers should
yield an initial item promptly (documented). The heartbeat necessarily starts
only after the flush.

**Post-flush error discipline:** once headers are flushed, `sendStream` must
be non-throwing — write/socket errors are caught and end the stream; nothing
escapes to `makeHandler`'s `next(err)` (which would hit `sendError` →
`res.status().json()` → `ERR_HTTP_HEADERS_SENT`). Belt-and-braces:
`sendError` gains a `res.headersSent` guard that destroys the socket instead
of writing a JSON body.

### OpenAPI emission

`operationFromOptions` emits for stream routes:

```yaml
responses:
  '200':
    content:
      text/event-stream:
        x-itemSchema: <z.toJSONSchema(streamOf)>
```

The document stays version `3.1.1`. **Review note:** a bare `itemSchema`
key inside a 3.1 Media Type Object is _not_ valid — strict validators
(Spectral, swagger-parser) reject unknown non-`x-` fields. We therefore emit
`x-itemSchema` today, and rename to `itemSchema` when emission bumps to
OpenAPI 3.2.0 (follow-up, gated on Swagger UI support). A framework whose
thesis is boundary coherence must not serve an invalid `/openapi.json`.

### Client (`@agentback/client`)

`RouteSchemas` gains `streamOf?: ZodType`. `RouteHandle` gains:

```ts
stream(client, input, options?): AsyncIterable<RouteOutput-item>
```

Implementation: `fetch` with `Accept: text/event-stream`, incremental SSE
parse over `response.body` (ReadableStream) — `data:` lines JSON-parsed and
validated against `streamOf` (validation failures throw `ClientError` with
issues, consistent with `executeRoute`'s response validation). `event: error`
frames throw a `ClientError` carrying the server's error payload. Abort via
`options.signal`. No new dependency — the SSE parser is ~60 lines and lives
in the client package (browser-safe, no Node APIs).

## Implementation plan

1. `openapi`: `streamOf` in `RouteOptions` + `RouteSchemas`, registry
   plumbing, decoration-time exclusivity check, `SuccessReturn` typing,
   `itemSchema` emission.
2. `rest`: `sendStream`, routing in `makeHandler`, first-item pull semantics,
   disconnect wiring, `sse.pingMs` config.
3. `client`: `stream()` + SSE parser.
4. Tests: unit (SSE framing, validation failure mid-stream, pre-first-yield
   error → HTTP status, disconnect calls generator cleanup), acceptance
   (end-to-end: server generator → client `for await`), OpenAPI snapshot with
   `itemSchema`.
5. Docs: guide section + example route in `hello-rest`.

## Sequencing

This proposal lands **before** P1-2 (Standard Schema): both rewrite the same
typing seam (`RouteInput`/`SuccessReturn`/`RouteDescriptor`), and P1-2's
threading checklist must include `streamOf` (validation via `standardParse`,
emission via `schemaToJSONSchema`).

## Out of scope

- WebSockets (SSE/JSONL covers the dominant agent case; WS is a later proposal).
- JSONL (`application/jsonl`) — **done.** Added behind `format?: 'sse' | 'jsonl'`
  on streaming routes (default `'sse'`), with no API change to existing SSE
  routes. The server's `sendStream` shares one pull/validate/cleanup loop across
  both formats, differing only in a framer (how an item / terminal error is
  serialized); OpenAPI emits the `200` response under `application/jsonl` with
  `x-itemSchema` (promoted to `itemSchema` on 3.2+ docs); the client's
  `route.stream()` sends `Accept: application/jsonl` and parses NDJSON via
  `parseNDJSON` (a terminal `{"error":{...}}` line throws `ClientError`, same
  contract as SSE `event: error`).
- MCP progress-notification mapping for the same generators — tracked in
  P1-3; the `streamOf` metadata is deliberately transport-neutral so that
  mapping can reuse it.
