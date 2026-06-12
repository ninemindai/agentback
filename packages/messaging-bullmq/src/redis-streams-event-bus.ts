// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
import {loggers} from '@agentback/common';
import type {
  EventBus,
  MsgMeta,
  PublishOptions,
  SubscribeOptions,
  Subscription,
  TopicDescriptor,
} from '@agentback/messaging';
import type {RedisConnectionManager} from './connection.js';

const {error: logError, debug} = loggers('messaging:bullmq:event-bus');

export interface RedisStreamsEventBusOptions {
  /** Stream key prefix (default `lba:events`). */
  prefix?: string;
  /** `XREADGROUP BLOCK` window per poll in ms (default 1000). */
  blockMs?: number;
  /**
   * Minimum idle time (ms) before a pending entry is reclaimed from a dead
   * or stuck consumer via `XAUTOCLAIM` (default 30_000).
   */
  reclaimMinIdleMs?: number;
  /** How often each subscriber runs `XAUTOCLAIM` in ms (default 15_000). */
  reclaimIntervalMs?: number;
}

type StreamEntry = [id: string, fields: string[] | null];

function fieldsToMap(fields: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map[fields[i]] = fields[i + 1];
  }
  return map;
}

/**
 * EventBus over Redis Streams directly (named for what it is — not BullMQ):
 * `XADD` to publish, one `XREADGROUP` loop per subscription (per-group
 * cursors give independent fan-out), `XACK` on handler resolve
 * (at-least-once), and a periodic `XAUTOCLAIM` reclaim timer that re-delivers
 * entries left pending by crashed or throwing consumers.
 */
export class RedisStreamsEventBus implements EventBus {
  private subscriptions = new Set<Subscription>();

  constructor(
    private connections: RedisConnectionManager,
    private options: RedisStreamsEventBusOptions = {},
  ) {}

  private streamKey(topic: string): string {
    return `${this.options.prefix ?? 'lba:events'}:${topic}`;
  }

  async publish<E>(
    t: TopicDescriptor<E>,
    event: E,
    opts: PublishOptions = {},
  ): Promise<void> {
    const parsed = t.schema.parse(event);
    await this.connections.base.xadd(
      this.streamKey(t.name),
      '*',
      'payload',
      JSON.stringify(parsed),
      'publishedAt',
      String(Date.now()),
      // Transport metadata envelope: its own field beside the payload, so
      // the validated payload shape on the wire is unchanged.
      'meta',
      JSON.stringify(opts.meta ?? {}),
    );
  }

  subscribe<E>(
    t: TopicDescriptor<E>,
    group: string,
    handler: (event: E, msg: MsgMeta) => Promise<void>,
    opts: SubscribeOptions = {},
  ): Subscription {
    // Each subscribe loop blocks in XREADGROUP — dedicated connection.
    const conn = this.connections.duplicate();
    const key = this.streamKey(t.name);
    const consumer = `consumer-${randomUUID()}`;
    const blockMs = this.options.blockMs ?? 1000;
    const reclaimIntervalMs = this.options.reclaimIntervalMs ?? 15_000;
    const reclaimMinIdleMs = this.options.reclaimMinIdleMs ?? 30_000;
    let closed = false;

    // Note: opts.concurrency is not yet honored (delivery is in-order,
    // sequential per subscription) — parity with the in-memory adapter.
    const deliver = async (
      id: string,
      fields: string[],
      reclaimed: boolean,
    ): Promise<void> => {
      let deliveryCount = 1;
      if (reclaimed) {
        // XAUTOCLAIM already incremented the delivery counter; read it back.
        const pending = (await conn.xpending(key, group, id, id, 1)) as Array<
          [string, string, number, number]
        >;
        deliveryCount = pending?.[0]?.[3] ?? 2;
      }
      const map = fieldsToMap(fields);
      try {
        const data = t.schema.parse(JSON.parse(map.payload ?? 'null')) as E;
        let meta: Record<string, string> = {};
        try {
          // Entries published before the meta field existed have no field.
          meta = map.meta ? JSON.parse(map.meta) : {};
        } catch {
          // Malformed meta never blocks delivery of a valid payload.
        }
        await handler(data, {
          id,
          topic: t.name,
          group,
          deliveryCount,
          publishedAt: Number(map.publishedAt ?? 0),
          meta,
        });
        await conn.xack(key, group, id);
      } catch (err) {
        // No XACK: the entry stays pending and is redelivered by the
        // reclaim timer after reclaimMinIdleMs (at-least-once).
        logError(
          'event %s on %s (group %s, delivery %d) failed: %O',
          id,
          t.name,
          group,
          deliveryCount,
          err,
        );
      }
    };

    const loop = async (): Promise<void> => {
      try {
        await conn.xgroup(
          'CREATE',
          key,
          group,
          opts.fromStart ? '0' : '$',
          'MKSTREAM',
        );
        debug('created group %s on %s', group, key);
      } catch (err) {
        if (!String(err).includes('BUSYGROUP')) throw err;
      }
      let nextReclaim = Date.now() + reclaimIntervalMs;
      while (!closed) {
        try {
          if (Date.now() >= nextReclaim) {
            nextReclaim = Date.now() + reclaimIntervalMs;
            // [cursor, entries] (Redis 7 appends deleted-entry ids).
            const claimed = (await conn.xautoclaim(
              key,
              group,
              consumer,
              reclaimMinIdleMs,
              '0-0',
              'COUNT',
              64,
            )) as [string, StreamEntry[]];
            for (const [id, fields] of claimed?.[1] ?? []) {
              if (closed) break;
              if (!fields) {
                // Tombstone: the entry was deleted from the stream.
                await conn.xack(key, group, id);
                continue;
              }
              await deliver(id, fields, true);
            }
          }
          const block = Math.max(
            1,
            Math.min(blockMs, nextReclaim - Date.now()),
          );
          const res = (await conn.xreadgroup(
            'GROUP',
            group,
            consumer,
            'COUNT',
            16,
            'BLOCK',
            block,
            'STREAMS',
            key,
            '>',
          )) as Array<[string, StreamEntry[]]> | null;
          for (const [, entries] of res ?? []) {
            for (const [id, fields] of entries) {
              if (closed) break;
              if (fields) await deliver(id, fields, false);
            }
          }
        } catch (err) {
          if (closed) break;
          logError('subscribe loop for %s/%s: %O', t.name, group, err);
          await new Promise<void>(r => setTimeout(r, 100));
        }
      }
    };
    const done = loop();

    const subscription: Subscription = {
      close: async () => {
        closed = true;
        // Break a blocked XREADGROUP so the loop can observe `closed`.
        conn.disconnect();
        await done.catch(() => undefined);
        await this.connections.release(conn);
        this.subscriptions.delete(subscription);
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  /** Close every live subscription loop (idempotent). */
  async close(): Promise<void> {
    await Promise.all(
      [...this.subscriptions].map(s => s.close().catch(() => undefined)),
    );
  }
}
