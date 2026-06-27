// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BOOT_ID, liveHandler, LIVE_HEARTBEAT_MS} from '../../live.js';

type FakeRes = {
  setHeader: (k: string, v: string) => void;
  flushHeaders?: () => void;
  write: (chunk: string) => boolean;
  writes: string[];
};
type FakeReq = {on: (ev: string, fn: () => void) => void; _close: () => void};

function fakes(): {req: FakeReq; res: FakeRes} {
  const writes: string[] = [];
  let closeFn = () => {};
  return {
    req: {
      on: (ev, fn) => {
        if (ev === 'close') closeFn = fn;
      },
      _close: () => closeFn(),
    },
    res: {
      setHeader: () => {},
      flushHeaders: () => {},
      write: c => (writes.push(c), true),
      writes,
    },
  };
}

describe('liveHandler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes a hello frame carrying BOOT_ID on connect', () => {
    const {req, res} = fakes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveHandler(req as any, res as any);
    expect(res.writes[0]).toBe(
      `data: ${JSON.stringify({type: 'hello', bootId: BOOT_ID})}\n\n`,
    );
  });

  it('emits heartbeats on an interval and stops on req close', () => {
    const {req, res} = fakes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    liveHandler(req as any, res as any);
    vi.advanceTimersByTime(LIVE_HEARTBEAT_MS);
    expect(res.writes).toContain(':hb\n\n');
    const after = res.writes.length;
    req._close();
    vi.advanceTimersByTime(LIVE_HEARTBEAT_MS * 2);
    expect(res.writes.length).toBe(after); // no writes after close
  });

  it('BOOT_ID is a stable non-empty string within the process', () => {
    expect(typeof BOOT_ID).toBe('string');
    expect(BOOT_ID.length).toBeGreaterThan(0);
  });
});
