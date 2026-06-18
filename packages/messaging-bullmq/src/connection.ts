// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {Redis, type RedisOptions} from 'ioredis';

const {debug} = loggers('messaging:bullmq:connection');

/** How the adapter reaches Redis. */
export interface BullMQConnectionConfig {
  /** Redis connection URL, e.g. `redis://localhost:6379`. */
  url?: string;
  /** Extra ioredis options, merged over the URL-derived ones. */
  options?: RedisOptions;
  /**
   * Bring-your-own ioredis client. The manager takes ownership and closes it
   * on stop; `url`/`options` are ignored when set.
   */
  client?: Redis;
}

/**
 * Connection discipline for the BullMQ adapter: a single base connection
 * serves queues/admin (plain request-response commands), and every consumer
 * of blocking commands — each BullMQ `Worker`, each event-bus subscribe
 * loop — gets its own `duplicate()` (with `maxRetriesPerRequest: null`, as
 * BullMQ workers require). Sharing one socket would deadlock: a blocked
 * `XREADGROUP`/`BRPOPLPUSH` starves every other command on the connection.
 * All duplicates are tracked and closed on stop.
 */
export class RedisConnectionManager {
  readonly base: Redis;
  private duplicates = new Set<Redis>();

  constructor(config: BullMQConnectionConfig = {}) {
    if (config.client) {
      this.base = config.client;
    } else if (config.url) {
      this.base = new Redis(config.url, config.options ?? {});
    } else {
      this.base = new Redis(config.options ?? {});
    }
  }

  /** Create and track a duplicate suited for blocking consumers. */
  duplicate(overrides: RedisOptions = {}): Redis {
    const dup = this.base.duplicate({
      maxRetriesPerRequest: null,
      ...overrides,
    });
    this.duplicates.add(dup);
    return dup;
  }

  /** Close and untrack a single duplicate (used by Subscription.close). */
  async release(conn: Redis): Promise<void> {
    this.duplicates.delete(conn);
    await quietClose(conn);
  }

  /** Close every tracked duplicate, then the base connection. */
  async close(): Promise<void> {
    debug('closing %d duplicate connection(s) + base', this.duplicates.size);
    await Promise.all([...this.duplicates].map(quietClose));
    this.duplicates.clear();
    await quietClose(this.base);
  }
}

async function quietClose(conn: Redis): Promise<void> {
  if (conn.status === 'end') return;
  try {
    await conn.quit();
  } catch {
    conn.disconnect();
  }
}
