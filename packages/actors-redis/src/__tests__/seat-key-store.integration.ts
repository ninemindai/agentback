// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {runSeatKeyStoreConformance} from '@agentback/actors/testing';
import {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {randomBytes} from 'node:crypto';
import {afterAll, describe, expect, it} from 'vitest';
import {RedisSeatKeyStore} from '../seat-key-store.js';

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  describe.skip('RedisSeatKeyStore integration (REDIS_URL not set)', () => {
    it('requires Redis', () => {});
  });
} else {
  const connections = new RedisConnectionManager({url: REDIS_URL});
  const testPrefix = `agentback:test:actors:seatKeys:${crypto.randomUUID()}`;
  let storeNumber = 0;
  // Records live in Redis, not in the instance, so a second store over the
  // same prefix is a second *view* of one storage — which is what lets the
  // conformance suite open the rotated-KEK case here.
  const prefixes = new WeakMap<RedisSeatKeyStore, string>();
  const store = (kek: Buffer = randomBytes(32)) => {
    const prefix = `${testPrefix}:${storeNumber++}`;
    const created = new RedisSeatKeyStore(connections, kek, {prefix});
    prefixes.set(created, prefix);
    return created;
  };

  runSeatKeyStoreConformance('redis', () => store(), {
    reopenWithWrongKek: opened =>
      new RedisSeatKeyStore(connections, randomBytes(32), {
        prefix: prefixes.get(opened as RedisSeatKeyStore)!,
      }),
  });

  describe('RedisSeatKeyStore distributed semantics', () => {
    it('resolves a concurrent create() race for the same actor to one winning key', async () => {
      const shared = store();
      const actor = {type: 'redis-seat', id: 'race'};

      const [first, second] = await Promise.all([
        shared.create(actor),
        shared.create(actor),
      ]);

      expect(second).toEqual(first);
    });

    it('lets two store instances agree on the same actor via shared Redis state', async () => {
      const prefix = `${testPrefix}:shared-${storeNumber++}`;
      const kek = randomBytes(32);
      const one = new RedisSeatKeyStore(connections, kek, {prefix});
      const two = new RedisSeatKeyStore(connections, kek, {prefix});
      const actor = {type: 'redis-seat', id: 'shared'};

      const created = await one.create(actor);
      const seenBySecond = await two.getByActor(actor);

      expect(seenBySecond).toEqual(created);
    });
  });

  afterAll(async () => {
    let cursor = '0';
    do {
      const [next, keys] = await connections.base.scan(
        cursor,
        'MATCH',
        `${testPrefix}:*`,
        'COUNT',
        200,
      );
      cursor = next;
      if (keys.length) await connections.base.del(...keys);
    } while (cursor !== '0');
    await connections.close();
  });
}
