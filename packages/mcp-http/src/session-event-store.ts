// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  EventId,
  EventStore,
  JSONRPCMessage,
  StreamId,
} from '@modelcontextprotocol/server';

/**
 * Scope a shared {@link EventStore} to one session.
 *
 * `installMcpHttp` hands the configured `eventStore` to every session, and the
 * SDK names every session's standalone stream `"_GET_stream"`. A store keyed
 * by stream id alone therefore replayed one session's standalone events to
 * another on a `Last-Event-ID` resume. Stream ids are prefixed with the
 * session id on the way in and stripped on the way out, so the transport
 * still sees its own stream names.
 *
 * Replay is buffered and forwarded only if the store resolves the id to one
 * of this session's streams: an event id is opaque to this wrapper, so a
 * crafted id naming another session's stream must not reach `send` first.
 * The buffer holds one resume's events, so it is bounded by the store's
 * retention (`InMemoryEventStore`'s `maxEvents`; for a store you write, by
 * what it keeps).
 */
export function sessionEventStore(
  store: EventStore,
  sessionId: string,
): EventStore {
  const prefix = `${sessionId}/`;
  const own = (streamId: StreamId | undefined) =>
    streamId?.startsWith(prefix) ? streamId.slice(prefix.length) : undefined;

  const scoped: EventStore = {
    storeEvent: (streamId: StreamId, message: JSONRPCMessage) =>
      store.storeEvent(prefix + streamId, message),

    async replayEventsAfter(lastEventId, {send}) {
      const replayed: [EventId, JSONRPCMessage][] = [];
      const streamId = own(
        await store.replayEventsAfter(lastEventId, {
          send: async (eventId, message) => {
            replayed.push([eventId, message]);
          },
        }),
      );
      if (streamId === undefined) return '';
      for (const [eventId, message] of replayed) await send(eventId, message);
      return streamId;
    },
  };
  if (store.getStreamIdForEventId) {
    const lookup = store.getStreamIdForEventId.bind(store);
    scoped.getStreamIdForEventId = async eventId => own(await lookup(eventId));
  }
  return scoped;
}
