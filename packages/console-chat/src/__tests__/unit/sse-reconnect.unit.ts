// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Unit tests for `openSseStream` reconnect / early-drop heuristic.
 *
 * Uses vitest fake timers and a stub EventSource factory so no real network
 * or DOM is required.  The three assertions from M5:
 *
 * (a) An early drop (< restartWindowMs, first occurrence) emits a
 *     `server_restart` event.
 * (b) Reconnect is bounded — the connection is not attempted more than
 *     `maxReconnects` additional times.
 * (c) A normal close (after restartWindowMs) does NOT emit `server_restart`.
 */

import {beforeEach, afterEach, describe, it, expect, vi} from 'vitest';
import {openSseStream, type SseClientEvent} from '../../client/sse.js';

// ---------------------------------------------------------------------------
// Minimal stub EventSource
// ---------------------------------------------------------------------------

interface StubEs {
  onmessage: ((ev: {data: unknown}) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  closeCalls: number;
  close(): void;
  /** Test helper: fire the onerror handler to simulate a drop. */
  drop(): void;
}

function makeStubEs(): StubEs {
  const es: StubEs = {
    onmessage: null,
    onerror: null,
    closeCalls: 0,
    close() {
      es.closeCalls++;
    },
    drop() {
      es.onerror?.(new Event('error'));
    },
  };
  return es;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('openSseStream reconnect heuristic', () => {
  let instances: StubEs[];
  let factory: (url: string) => StubEs;

  beforeEach(() => {
    instances = [];
    factory = (_url: string) => {
      const es = makeStubEs();
      instances.push(es);
      return es;
    };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // (a) Early drop on first occurrence → server_restart
  // -------------------------------------------------------------------------
  it('(a) emits server_restart on an early drop (first occurrence, within restart window)', () => {
    const events: SseClientEvent[] = [];
    const errors: unknown[] = [];

    openSseStream('http://localhost/stream', ev => events.push(ev), err => errors.push(err), {
      reconnectDelayMs: 500,
      maxReconnects: 3,
      restartWindowMs: 5000,
      eventSourceFactory: factory,
    });

    // Initial connection is established.
    expect(instances.length).toBe(1);

    // Drop occurs immediately (< 5000 ms from connectTime=0).
    instances[0].drop();

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('server_restart');
    // No error callback yet — we haven't exhausted retries.
    expect(errors.length).toBe(0);

    // Reconnect should be scheduled but not yet fired.
    expect(instances.length).toBe(1);
    vi.advanceTimersByTime(500);
    expect(instances.length).toBe(2);
  });

  // -------------------------------------------------------------------------
  // (b) Reconnect is bounded — does not exceed maxReconnects
  // -------------------------------------------------------------------------
  it('(b) stops reconnecting after maxReconnects attempts and calls onError', () => {
    const events: SseClientEvent[] = [];
    const errors: unknown[] = [];

    const maxReconnects = 2;
    openSseStream('http://localhost/stream', ev => events.push(ev), err => errors.push(err), {
      reconnectDelayMs: 100,
      maxReconnects,
      restartWindowMs: 5000,
      eventSourceFactory: factory,
    });

    // Advance time far past restartWindowMs for subsequent drops so we're not
    // in the early-drop window (avoids extra server_restart events after the
    // first reconnect).
    const AFTER_WINDOW = 6000;

    // Initial connection (attempt 0): drop after window so no server_restart.
    expect(instances.length).toBe(1);
    vi.advanceTimersByTime(AFTER_WINDOW);
    instances[0].drop(); // drop — reconnectCount becomes 1

    vi.advanceTimersByTime(100);
    expect(instances.length).toBe(2);

    // Attempt 1: drop after window.
    vi.advanceTimersByTime(AFTER_WINDOW);
    instances[1].drop(); // drop — reconnectCount becomes 2 (= maxReconnects)

    vi.advanceTimersByTime(100);
    expect(instances.length).toBe(3);

    // Attempt 2: drop — reconnectCount (2) >= maxReconnects (2) → no more reconnects.
    vi.advanceTimersByTime(AFTER_WINDOW);
    instances[2].drop();

    // No further timer needed — onError should be called synchronously.
    expect(errors.length).toBe(1);
    expect((errors[0] as Error).message).toMatch(/failed after retries/i);

    // No new EventSource beyond the maxReconnects attempts.
    vi.advanceTimersByTime(1000);
    expect(instances.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // (c) Drop AFTER restartWindowMs does NOT emit server_restart
  // -------------------------------------------------------------------------
  it('(c) does not emit server_restart when the drop occurs after the restart window', () => {
    const events: SseClientEvent[] = [];

    openSseStream('http://localhost/stream', ev => events.push(ev), undefined, {
      reconnectDelayMs: 100,
      maxReconnects: 3,
      restartWindowMs: 5000,
      eventSourceFactory: factory,
    });

    expect(instances.length).toBe(1);

    // Advance past the restart window before dropping.
    vi.advanceTimersByTime(5001);
    instances[0].drop();

    // server_restart must NOT be in the events list.
    const restartEvents = events.filter(e => e.type === 'server_restart');
    expect(restartEvents.length).toBe(0);
  });
});
