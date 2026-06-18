// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  EventStore,
  EventId,
  StreamId,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';

/**
 * A simple in-memory {@link EventStore} enabling **resumable** Streamable HTTP
 * sessions: if a client's SSE stream drops, it reconnects with `Last-Event-ID`
 * and the transport replays the events it missed.
 *
 * Suitable for a single process / development. For multi-instance or durable
 * deployments, implement `EventStore` over a shared store (e.g. Redis) — the
 * interface is just `storeEvent` + `replayEventsAfter`.
 */
export class InMemoryEventStore implements EventStore {
  // Insertion-ordered: Map preserves order, and the monotonically increasing
  // counter makes event ids sortable within a stream.
  private readonly events = new Map<
    EventId,
    {streamId: StreamId; message: JSONRPCMessage}
  >();
  private counter = 0;

  async storeEvent(
    streamId: StreamId,
    message: JSONRPCMessage,
  ): Promise<EventId> {
    const eventId = `${streamId}::${String(this.counter++).padStart(12, '0')}`;
    this.events.set(eventId, {streamId, message});
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
