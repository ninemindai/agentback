// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {AbortReasons, isAbortError} from '@agentback/common';
import {JobDeadlines} from '../../job-deadlines.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('JobDeadlines', () => {
  it('resolves normally and stops tracking the attempt', async () => {
    const d = new JobDeadlines();
    await d.run('j1', 1000, async () => {});
    expect(d.has('j1')).toBe(false);
  });

  it('rejects with an AbortError once the budget elapses', async () => {
    const d = new JobDeadlines();
    const err = await d
      .run('j2', 20, () => new Promise<void>(() => {}))
      .catch(e => e);
    expect(isAbortError(err)).toBe(true);
    expect((err as DOMException).message).toBe(AbortReasons.DEADLINE);
    expect(d.has('j2')).toBe(false);
  });

  it('returns before a stalled handler does — the whole point', async () => {
    const d = new JobDeadlines();
    let handlerFinished = false;
    const started = Date.now();
    await d
      .run('j3', 20, async () => {
        await sleep(400);
        handlerFinished = true;
      })
      .catch(() => {});
    // The seat is freed on the clock, not on the handler.
    expect(Date.now() - started).toBeLessThan(300);
    expect(handlerFinished).toBe(false);
  });

  it('abort() reaches a running attempt and reports whether it found one', async () => {
    const d = new JobDeadlines();
    let reason: unknown;
    const run = d
      .run(
        'j5',
        undefined,
        signal =>
          new Promise<void>(resolve =>
            signal.addEventListener('abort', () => {
              reason = signal.reason;
              resolve();
            }),
          ),
      )
      .catch(e => e);
    await sleep(10);
    expect(d.abort('j5')).toBe(true);
    await run;
    expect((reason as DOMException).message).toBe(AbortReasons.CANCELLED);
    // Nothing is running under an unknown id.
    expect(d.abort('nope')).toBe(false);
  });
});
