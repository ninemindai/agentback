// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ServerResponse} from 'node:http';

/**
 * Write a Web {@link globalThis.Response} back onto a Node
 * {@link ServerResponse} — the shared Node↔Web *response* half used by both the
 * Express web-dispatch path (`writeWebResponseToExpress`, which delegates here)
 * and the Fastify host adapter (which writes to `reply.raw`). `ServerResponse`
 * is the common supertype — Express's `Response` extends it — so the same writer
 * serves both.
 *
 * Copies status + headers, then writes the body: a streaming `ReadableStream`
 * (SSE/JSONL) is pumped chunk-by-chunk and the socket is destroyed on a
 * mid-stream error (parity with `sendStream`); a buffered body is written in one
 * shot; a null body ends the response empty. `set-cookie` multiplicity is
 * preserved via `getSetCookie()`.
 */
export async function writeWebResponseToNode(
  res: ServerResponse,
  response: globalThis.Response,
): Promise<void> {
  res.statusCode = response.status;
  // Preserve multiple Set-Cookie headers, which `Headers.forEach` would
  // comma-join. Everything else copies through as-is.
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) res.setHeader('set-cookie', setCookies);
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === 'set-cookie') return;
    res.setHeader(name, value);
  });

  const body = response.body;
  if (body == null) {
    res.end();
    return;
  }

  const reader = body.getReader();
  res.flushHeaders();

  // Client disconnect: cancel the Web stream so RestHandler's `cancel()` runs
  // `iterator.return?.()` and the handler generator's `finally` releases its
  // resources — parity with sendStream's `res.on('close')`.
  let aborted = false;
  const onClose = () => {
    aborted = true;
    void reader.cancel();
  };
  res.on('close', onClose);

  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (value && !aborted) res.write(Buffer.from(value));
    }
    if (!aborted) res.end();
  } catch {
    // The Response stream already commits a terminal error frame for handler
    // failures (RestHandler.toStreamResponse). A transport read error here means
    // the socket is unusable — destroy it rather than crash.
    if (aborted) {
      // client already gone; nothing to write
    } else if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    } else res.destroy();
  } finally {
    res.removeListener('close', onClose);
    reader.releaseLock?.();
  }
}
