// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  EventStore,
  EventId,
  StreamId,
  JSONRPCMessage,
} from '@modelcontextprotocol/server';

/**
 * A simple in-memory {@link EventStore} enabling **resumable** Streamable HTTP
 * sessions: if a client's SSE stream drops, it reconnects with `Last-Event-ID`
 * and the transport replays the events it missed.
 *
 * Suitable for a single process / development. For multi-instance or durable
 * deployments, implement `EventStore` over a shared store (e.g. Redis) — the
 * interface is just `storeEvent` + `replayEventsAfter`.
 *
 * Bounded: it holds at most `maxEvents` (default 10,000) **across all
 * streams**, evicting the oldest first. The transport never tells a store that
 * a stream or session ended, so without a cap every message of every session
 * stayed in memory for the life of the process. The cap is global, not
 * per-stream (unlike `rest`'s `resumable.maxEvents`): a chatty stream can
 * evict another's replay window, and a client resuming from an evicted event
 * is treated like one presenting an unknown id.
 */
export class InMemoryEventStore implements EventStore {
  // Insertion-ordered: Map preserves order, and the monotonically increasing
  // counter makes event ids sortable within a stream.
  private readonly events = new Map<
    EventId,
    {streamId: StreamId; message: JSONRPCMessage}
  >();
  private counter = 0;
  private readonly maxEvents: number;

  constructor(options: {maxEvents?: number} = {}) {
    const maxEvents = options.maxEvents ?? 10_000;
    if (!Number.isInteger(maxEvents) || maxEvents < 1) {
      throw new RangeError(
        `InMemoryEventStore: maxEvents must be an integer >= 1 (got ${maxEvents})`,
      );
    }
    this.maxEvents = maxEvents;
  }

  async storeEvent(
    streamId: StreamId,
    message: JSONRPCMessage,
  ): Promise<EventId> {
    const eventId = `${streamId}::${String(this.counter++).padStart(12, '0')}`;
    this.events.set(eventId, {streamId, message});
    if (this.events.size > this.maxEvents) {
      // Map iterates in insertion order, so the first key is the oldest.
      this.events.delete(this.events.keys().next().value!);
    }
    return eventId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    {
      send,
    }: {send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>},
  ): Promise<StreamId> {
    const anchor = lastEventId ? this.events.get(lastEventId) : undefined;
    if (!anchor) return '';
    let reached = false;
    for (const [eventId, {streamId, message}] of this.events) {
      if (eventId === lastEventId) {
        reached = true;
        continue;
      }
      if (reached && streamId === anchor.streamId) {
        await send(eventId, message);
      }
    }
    return anchor.streamId;
  }
}
