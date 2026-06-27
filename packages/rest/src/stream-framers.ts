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
  /** Serialize one validated item to its wire representation. */
  item(data: unknown): string;
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
  item(data) {
    return `data: ${JSON.stringify(data)}\n\n`;
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
    return JSON.stringify(data) + '\n';
  },
  error(payload) {
    return JSON.stringify({error: payload}) + '\n';
  },
};
