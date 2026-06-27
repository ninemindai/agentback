// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {CompositeUsageSink} from '../../composite-sink.js';
import {InMemoryUsageSink} from '../../in-memory-sink.js';
import type {UsageEvent, UsageSink} from '../../types.js';

const event = (id: string): UsageEvent => ({
  id,
  at: '2026-06-08T00:00:00.000Z',
  status: 'ok',
  latencyMs: 1,
  units: 1,
  surface: 'rest',
  operation: 'X.y',
  principal: {kind: 'client', id: 'c'},
});

describe('CompositeUsageSink', () => {
  it('fans each event out to every child sink', async () => {
    const a = new InMemoryUsageSink();
    const b = new InMemoryUsageSink();
    const composite = new CompositeUsageSink([a, b]);

    await composite.record(event('1'));

    expect(a.all()).toHaveLength(1);
    expect(b.all()).toHaveLength(1);
    expect(a.all()[0].id).toBe('1');
  });

  it('awaits async child sinks', async () => {
    const recorded: string[] = [];
    const slow: UsageSink = {
      record: async e => {
        await new Promise(r => setTimeout(r, 1));
        recorded.push(e.id);
      },
    };
    await new CompositeUsageSink([slow]).record(event('async'));
    expect(recorded).toEqual(['async']);
  });

  it('records to no sinks without error (empty composite)', async () => {
    await expect(
      new CompositeUsageSink([]).record(event('x')),
    ).resolves.toBeUndefined();
  });
});
