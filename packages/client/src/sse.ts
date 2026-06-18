// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/** One parsed server-sent event. */
export interface SSEEvent {
  /** The `event:` field; absent for default (`message`) events. */
  event?: string;
  /** Joined `data:` lines. */
  data: string;
}

/**
 * Incrementally parse a `text/event-stream` body into events. Handles LF and
 * CRLF framing, multi-line `data:`, ignores comment lines (`:`) and fields we
 * don't use (`id:`, `retry:`). Browser-safe — Web Streams + TextDecoder only.
 */
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = '';
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const flush = (): SSEEvent | undefined => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return undefined;
    }
    const evt: SSEEvent = {data: dataLines.join('\n')};
    if (eventName) evt.event = eventName;
    dataLines = [];
    eventName = undefined;
    return evt;
  };

  const handleLine = (line: string): SSEEvent | undefined => {
    if (line === '') return flush();
    if (line.startsWith(':')) return undefined; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventName = value;
    // id:/retry: intentionally ignored.
    return undefined;
  };

  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        const evt = handleLine(line);
        if (evt) yield evt;
      }
    }
    // Stream ended: emit any complete trailing event.
    if (buffer.length > 0)
      handleLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
    const evt = flush();
    if (evt) yield evt;
  } finally {
    reader.releaseLock();
  }
}
