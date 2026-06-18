// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Incrementally parse a newline-delimited JSON (`application/jsonl`) body into
 * its lines. Handles arbitrary chunk boundaries, tolerates CRLF line endings,
 * and skips blank lines. Each yielded string is one raw JSON line (not yet
 * `JSON.parse`d — the caller decides how to interpret it). Browser-safe — Web
 * Streams + TextDecoder only, no Node APIs.
 */
export async function* parseNDJSON(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';

  const trim = (line: string): string =>
    line.endsWith('\r') ? line.slice(0, -1) : line;

  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = trim(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) yield line;
      }
    }
    // Flush any complete trailing line (no terminating newline).
    const tail = trim(buffer);
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}
