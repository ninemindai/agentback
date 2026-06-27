// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  startLiveBus,
  subscribeReload,
  subscribeStatus,
  type EventSourceFactory,
} from '../../client/live.js';

// A controllable fake EventSource: tests drive onmessage/onerror by hand.
class FakeES {
  onmessage: ((ev: {data: unknown}) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  hello(bootId: string) {
    this.onmessage?.({data: JSON.stringify({type: 'hello', bootId})});
  }
  drop() {
    this.onerror?.(new Error('drop'));
  }
}

function harness() {
  const created: FakeES[] = [];
  const factory: EventSourceFactory = () => {
    const es = new FakeES();
    created.push(es);
    return es as unknown as ReturnType<EventSourceFactory>;
  };
  return {created, factory};
}

describe('liveBus', () => {
  let stop: (() => void) | undefined;
  // Drained in afterEach so a failing assertion can't leak a listener into the
  // module-level (singleton) bus and perturb a later test.
  const unsubs: Array<() => void> = [];
  afterEach(() => {
    for (const un of unsubs.splice(0)) un();
    stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('does NOT fire reload on the first hello (records baseline)', () => {
    const {created, factory} = harness();
    const reloads: number[] = [];
    unsubs.push(subscribeReload(() => reloads.push(1)));
    stop = startLiveBus('/console/live', {eventSourceFactory: factory});
    created[0].hello('boot-A');
    expect(reloads.length).toBe(0);
  });

  it('fires reload when a reconnect returns a DIFFERENT boot id', () => {
    vi.useFakeTimers();
    const {created, factory} = harness();
    const reloads: number[] = [];
    unsubs.push(subscribeReload(() => reloads.push(1)));
    stop = startLiveBus('/console/live', {
      reconnectDelayMs: 10,
      eventSourceFactory: factory,
    });
    created[0].hello('boot-A'); // baseline
    created[0].drop(); // server restarts
    vi.advanceTimersByTime(10); // reconnect → created[1]
    created[1].hello('boot-B'); // new process
    expect(reloads.length).toBe(1);
  });

  it('does NOT fire reload when a reconnect returns the SAME boot id (blip)', () => {
    vi.useFakeTimers();
    const {created, factory} = harness();
    const reloads: number[] = [];
    unsubs.push(subscribeReload(() => reloads.push(1)));
    stop = startLiveBus('/console/live', {
      reconnectDelayMs: 10,
      eventSourceFactory: factory,
    });
    created[0].hello('boot-A');
    created[0].drop();
    vi.advanceTimersByTime(10);
    created[1].hello('boot-A'); // same process — transient blip
    expect(reloads.length).toBe(0);
  });

  it('reports disconnected on drop and connected on (re)hello', () => {
    vi.useFakeTimers();
    const {created, factory} = harness();
    const status: boolean[] = [];
    unsubs.push(subscribeStatus(s => status.push(s)));
    stop = startLiveBus('/console/live', {
      reconnectDelayMs: 10,
      eventSourceFactory: factory,
    });
    created[0].hello('boot-A'); // connected → true
    created[0].drop(); // → false
    vi.advanceTimersByTime(10);
    created[1].hello('boot-A'); // → true
    expect(status).toEqual([true, false, true]);
  });
});
