// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parseNDJSON} from '../../ndjson.js';

/** Build a ReadableStream from string chunks (arbitrary chunk boundaries). */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of parseNDJSON(body)) out.push(line);
  return out;
}

describe('parseNDJSON', () => {
  it('parses newline-delimited lines', async () => {
    const lines = await collect(streamOf('{"n":1}\n{"n":2}\n'));
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('handles chunk boundaries inside a line', async () => {
    const lines = await collect(streamOf('{"n', '":1}\n{"n', '":2}\n'));
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('emits a complete trailing line with no terminating newline', async () => {
    const lines = await collect(streamOf('{"n":1}\n{"n":2}'));
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('tolerates CRLF line endings', async () => {
    const lines = await collect(streamOf('{"n":1}\r\n{"n":2}\r\n'));
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('ignores blank lines', async () => {
    const lines = await collect(streamOf('{"n":1}\n\n\n{"n":2}\n'));
    expect(lines).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('handles a line split across many tiny chunks', async () => {
    const lines = await collect(
      streamOf(...'{"n":42}\n'.split('').flatMap(ch => [ch])),
    );
    expect(lines).toEqual(['{"n":42}']);
  });
});
