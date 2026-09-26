// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {ResumableStreamRegistry} from '../../resumable-streams.js';
import {SSE_FRAMER} from '../../stream-framers.js';

const Tick = z.object({n: z.number()});
const scope = {ctor: class {}, methodName: 'm', owner: undefined};

const rejections: unknown[] = [];
const onRejection = (err: unknown) => rejections.push(err);

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  rejections.length = 0;
});

describe('ResumableStream', () => {
  it('does not leak a rejection when the producer cleanup throws on dispose', async () => {
    process.on('unhandledRejection', onRejection);
    async function* producer() {
      try {
        for (let n = 1; ; n++) {
          yield {n};
          await new Promise(r => setTimeout(r, 5));
        }
      } finally {
        throw new Error('cleanup failed');
      }
    }
    const iterator = producer();
    const stream = new ResumableStreamRegistry().create(
      iterator,
      Tick,
      SSE_FRAMER,
      scope,
    );
    stream.attach(
      {write: () => true, drain: async () => {}, close() {}},
      new AbortController().signal,
    );
    void stream.pump(await iterator.next());

    stream.dispose();
    await new Promise(r => setTimeout(r, 50));
    expect(rejections).toEqual([]);
  });
});
