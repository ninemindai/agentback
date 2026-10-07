// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import type {EventStore, JSONRPCMessage} from '@modelcontextprotocol/server';
import {InMemoryEventStore} from '../../event-store.js';
import {sessionEventStore} from '../../session-event-store.js';

// The SDK names every session's standalone stream "_GET_stream", and
// installMcpHttp hands one EventStore to every session. Keyed by stream id
// alone, a resume in one session replayed the others' standalone events.

const msg = (n: number): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/tools/list_changed',
  params: {n},
});

async function replay(store: EventStore, lastEventId: string) {
  const sent: string[] = [];
  const streamId = await store.replayEventsAfter(lastEventId, {
    send: async eventId => {
      sent.push(eventId);
    },
  });
  return {streamId, sent};
}

describe('sessionEventStore', () => {
  it('replays only its own session’s events from a shared store', async () => {
    const shared = new InMemoryEventStore();
    const a = sessionEventStore(shared, 'session-a');
    const b = sessionEventStore(shared, 'session-b');

    const a1 = await a.storeEvent('_GET_stream', msg(1));
    await b.storeEvent('_GET_stream', msg(2));
    const a2 = await a.storeEvent('_GET_stream', msg(3));
    await b.storeEvent('_GET_stream', msg(4));

    // The stream id handed back is the SDK's own, so the transport still
    // recognises its standalone stream.
    expect(await replay(a, a1)).toEqual({streamId: '_GET_stream', sent: [a2]});
  });

  it('replays nothing for another session’s event id', async () => {
    const shared = new InMemoryEventStore();
    const a = sessionEventStore(shared, 'session-a');
    const b = sessionEventStore(shared, 'session-b');

    const b1 = await b.storeEvent('_GET_stream', msg(1));
    await b.storeEvent('_GET_stream', msg(2));
    await a.storeEvent('_GET_stream', msg(3));

    expect(await replay(a, b1)).toEqual({streamId: '', sent: []});
  });

  it('answers getStreamIdForEventId only for its own events', async () => {
    const calls: string[] = [];
    const inner = new InMemoryEventStore();
    const withLookup: EventStore = {
      storeEvent: (s, m) => inner.storeEvent(s, m),
      replayEventsAfter: (id, o) => inner.replayEventsAfter(id, o),
      getStreamIdForEventId: async id => {
        calls.push(id);
        return id.slice(0, id.lastIndexOf('::'));
      },
    };
    const a = sessionEventStore(withLookup, 'session-a');
    const b = sessionEventStore(withLookup, 'session-b');
    const a1 = await a.storeEvent('_GET_stream', msg(1));
    const b1 = await b.storeEvent('_GET_stream', msg(2));

    expect(await a.getStreamIdForEventId!(a1)).toBe('_GET_stream');
    expect(await a.getStreamIdForEventId!(b1)).toBeUndefined();
    expect(calls).toEqual([a1, b1]);
  });

  it('omits getStreamIdForEventId when the wrapped store has none', () => {
    const a = sessionEventStore(new InMemoryEventStore(), 'session-a');
    expect(a.getStreamIdForEventId).toBeUndefined();
  });
});
