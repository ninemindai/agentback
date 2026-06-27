// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {UsageEvent, UsageSink} from './types.js';

/**
 * The subset of a Redis client this sink uses. `ioredis`/`node-redis` satisfy
 * it structurally — pass your existing client; this package takes no Redis
 * dependency of its own.
 */
export interface RedisLike {
  sadd(key: string, member: string): Promise<number>;
  rpush(key: string, value: string): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
}

export interface RedisUsageSinkOptions {
  /** List key the events are appended to. Default `usage:events`. */
  eventsKey?: string;
  /** Set key used to dedup event ids. Default `usage:seen`. */
  seenKey?: string;
}

/**
 * Durable {@link UsageSink} backed by Redis — shared across instances, the
 * multi-process form of the audit log. Events are appended to a list; an event
 * id is added to a set first (`SADD`) and only appended when new, so retries
 * across processes don't double-log. `read()` replays the whole list; for large
 * volumes prefer a stream/consumer rather than a full replay.
 */
export class RedisUsageSink implements UsageSink {
  private readonly eventsKey: string;
  private readonly seenKey: string;

  constructor(
    private readonly redis: RedisLike,
    opts: RedisUsageSinkOptions = {},
  ) {
    this.eventsKey = opts.eventsKey ?? 'usage:events';
    this.seenKey = opts.seenKey ?? 'usage:seen';
  }

  async record(event: UsageEvent): Promise<void> {
    const fresh = await this.redis.sadd(this.seenKey, event.id);
    if (fresh === 1) {
      await this.redis.rpush(this.eventsKey, JSON.stringify(event));
    }
  }

  async read(): Promise<UsageEvent[]> {
    const raw = await this.redis.lrange(this.eventsKey, 0, -1);
    return raw.map(line => JSON.parse(line) as UsageEvent);
  }
}
