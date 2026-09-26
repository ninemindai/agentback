// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ErrorEnvelope} from '@agentback/openapi';

/** A serialized stream error payload (the wire shape both formats carry). */
export interface StreamErrorPayload extends Omit<
  ErrorEnvelope,
  'publicMessage' | 'statusCode'
> {
  statusCode: number;
  message: string;
  details?: unknown;
}

/**
 * The only thing that differs between stream wire formats: the response
 * headers and how an item / an error are serialized to bytes. The pull,
 * validate, disconnect, and cleanup disciplines in the caller are shared.
 */
export interface StreamFramer {
  headers: Record<string, string>;
  /**
   * Serialize one validated item to its wire representation. `id` is set only
   * on a `resumable:` route; a format with no id convention ignores it.
   */
  item(data: unknown, id?: string): string;
  /** Serialize a terminal error record to its wire representation. */
  error(payload: StreamErrorPayload): string;
}

/** Server-Sent Events: `data:`/`event:` frames separated by blank lines. */
export const SSE_FRAMER: StreamFramer = {
  headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  },
  item(data, id) {
    // `id:` is what makes a stream resumable: EventSource remembers the last
    // one it saw and replays it as `Last-Event-ID` on reconnect, with no
    // client code. Omitted entirely when the route is not `resumable:`, so a
    // plain stream's bytes are unchanged.
    const frame = `data: ${JSON.stringify(data)}\n\n`;
    return id === undefined ? frame : `id: ${id}\n${frame}`;
  },
  error(payload) {
    return `event: error\ndata: ${JSON.stringify({error: payload})}\n\n`;
  },
};

/**
 * Newline-delimited JSON: one compact JSON object per line. The media type is
 * `application/jsonl` (the `.jsonl` convention); `application/x-ndjson` is the
 * common alternative — we pick `application/jsonl` to match OpenAPI 3.2's
 * streaming guidance and keep the media type self-describing. A terminal error
 * is itself a JSON line `{"error":{statusCode,message,details?}}`, mirroring
 * the SSE `event: error` payload exactly so clients share one error contract.
 */
export const JSONL_FRAMER: StreamFramer = {
  headers: {
    'Content-Type': 'application/jsonl',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  },
  item(data) {
    // No id: NDJSON has no out-of-band frame metadata, and smuggling one into
    // the object would corrupt the item schema. `resumable:` is refused on a
    // jsonl route at decoration time for exactly this reason.
    return JSON.stringify(data) + '\n';
  },
  error(payload) {
    return JSON.stringify({error: payload}) + '\n';
  },
};
