// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {TopicDescriptor} from '../descriptors.js';
import type {EventBus} from '../ports.js';
import type {
  MsgMeta,
  PublishOptions,
  Subscription,
  SubscribeOptions,
} from '../types.js';

const {error: logError} = loggers('messaging:in-memory:event-bus');

interface Entry {
  id: string;
  raw: unknown;
  publishedAt: number;
  meta: Record<string, string>;
}

/** In-memory EventBus adapter with per-group cursors + redelivery. */
export class InMemoryEventBus implements EventBus {
  private counter = 0;
  private log = new Map<string, Entry[]>();
  private wakers = new Set<() => void>();

  private entries(topic: string): Entry[] {
    let l = this.log.get(topic);
    if (!l) {
      l = [];
      this.log.set(topic, l);
    }
    return l;
  }

  async publish<E>(
    t: TopicDescriptor<E>,
    event: E,
    opts: PublishOptions = {},
  ): Promise<void> {
    const parsed = t.schema.parse(event);
    this.entries(t.name).push({
      id: `evt_${++this.counter}`,
      raw: parsed,
      publishedAt: Date.now(),
      meta: opts.meta ?? {},
    });
    for (const w of this.wakers) w();
  }

  subscribe<E>(
    t: TopicDescriptor<E>,
    group: string,
    handler: (event: E, msg: MsgMeta) => Promise<void>,
    opts: SubscribeOptions = {},
  ): Subscription {
    // L1 adapter: `group` is a metadata label, not a shared consumer-group
    // cursor — two subscribes with the same group each get their own cursor
    // and both receive all events (a Redis Streams adapter differs).
    let closed = false;
    // Cursor: index into the topic log. fromStart → 0, else end (new only).
    let cursor = opts.fromStart ? 0 : this.entries(t.name).length;
    // L1 adapter: opts.concurrency is ignored; events are delivered in order.
    let wake: (() => void) | undefined;
    const waker = () => wake?.();
    this.wakers.add(waker);

    const pump = async (): Promise<void> => {
      while (!closed) {
        const entries = this.entries(t.name);
        if (cursor < entries.length) {
          const entry = entries[cursor];
          let delivery = 0;
          // Redeliver until the handler resolves (implicit ack-on-resolve).
          // Bounded loop guards against an always-throwing handler.
          let acked = false;
          while (!closed && !acked && delivery < 50) {
            delivery++;
            try {
              const data = t.schema.parse(entry.raw) as E;
              const msg: MsgMeta = {
                id: entry.id,
                topic: t.name,
                group,
                deliveryCount: delivery,
                publishedAt: entry.publishedAt,
                meta: entry.meta,
              };
              await handler(data, msg);
              acked = true;
            } catch (err) {
              logError(
                'event %s redeliver %d to group %s: %O',
                entry.id,
                delivery,
                group,
                err,
              );
              await new Promise<void>(r => setTimeout(r, 20));
            }
          }
          // L1 adapter: after the bounded retry budget is exhausted the cursor
          // advances past the event (no dead-letter). A Redis adapter would DLQ it.
          cursor++;
          continue;
        }
        await new Promise<void>(res => {
          wake = res;
          setTimeout(res, 10);
        });
      }
    };
    void pump();

    return {
      close: async () => {
        closed = true;
        this.wakers.delete(waker);
        wake?.();
      },
    };
  }
}
