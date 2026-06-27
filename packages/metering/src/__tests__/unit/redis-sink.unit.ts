// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {RedisUsageSink, type RedisLike} from '../../redis-sink.js';
import type {UsageEvent} from '../../types.js';

/** Minimal in-memory stand-in with Redis set + list semantics. */
class FakeRedis implements RedisLike {
  sets = new Map<string, Set<string>>();
  lists = new Map<string, string[]>();
  async sadd(key: string, member: string): Promise<number> {
    const s = this.sets.get(key) ?? new Set<string>();
    const isNew = !s.has(member);
    s.add(member);
    this.sets.set(key, s);
    return isNew ? 1 : 0;
  }
  async rpush(key: string, value: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.push(value);
    this.lists.set(key, l);
    return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    return stop === -1 ? l.slice(start) : l.slice(start, stop + 1);
  }
}

const event = (id: string, principalId = 'svc-1'): UsageEvent => ({
  id,
  at: '2026-06-08T00:00:00.000Z',
  status: 'ok',
  latencyMs: 5,
  units: 1,
  surface: 'rest',
  operation: 'WidgetController.list',
  principal: {kind: 'client', id: principalId},
});

describe('RedisUsageSink', () => {
  it('records events and reads them back', async () => {
    const sink = new RedisUsageSink(new FakeRedis());
    await sink.record(event('a'));
    await sink.record(event('b', 'alice'));
    const events = await sink.read();
    expect(events.map(e => e.id)).toEqual(['a', 'b']);
    expect(events[1].principal.id).toBe('alice');
  });

  it('is idempotent on event id (SADD-gated)', async () => {
    const sink = new RedisUsageSink(new FakeRedis());
    await sink.record(event('dup'));
    await sink.record(event('dup'));
    expect(await sink.read()).toHaveLength(1);
  });

  it('shares state across instances backed by the same client (durable)', async () => {
    const redis = new FakeRedis();
    await new RedisUsageSink(redis).record(event('x'));
    // A separate instance over the same client sees it — that's the point.
    const events = await new RedisUsageSink(redis).read();
    expect(events.map(e => e.id)).toEqual(['x']);
  });

  it('returns an empty list when nothing has been recorded', async () => {
    expect(await new RedisUsageSink(new FakeRedis()).read()).toEqual([]);
  });

  it('honors custom keys', async () => {
    const redis = new FakeRedis();
    const sink = new RedisUsageSink(redis, {eventsKey: 'u:e', seenKey: 'u:s'});
    await sink.record(event('a'));
    expect(redis.lists.has('u:e')).toBe(true);
    expect(redis.sets.has('u:s')).toBe(true);
  });
});
