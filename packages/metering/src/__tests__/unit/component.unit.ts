// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Context} from '@agentback/context';
import {MeteringComponent} from '../../component.js';
import {MeteringBindings} from '../../keys.js';
import {InMemoryUsageSink} from '../../in-memory-sink.js';
import {Meter} from '../../meter.js';

function contextWithComponent(): Context {
  const ctx = new Context('test');
  for (const b of new MeteringComponent().bindings) ctx.add(b);
  return ctx;
}

describe('MeteringComponent', () => {
  it('binds the sink as a shared singleton', async () => {
    const ctx = contextWithComponent();
    const a = await ctx.get(MeteringBindings.SINK);
    const b = await ctx.get(MeteringBindings.SINK);
    expect(a).toBe(b); // same instance, not a fresh transient each resolve
  });

  it('gives the Meter the same sink instance that consumers read', async () => {
    const ctx = contextWithComponent();
    const meter = await ctx.get<Meter>(MeteringBindings.METER);
    const sink = (await ctx.get(
      MeteringBindings.SINK,
    )) as unknown as InMemoryUsageSink;

    await meter.record({
      surface: 'rest',
      operation: 'X.y',
      principal: {kind: 'client', id: 'c'},
      status: 'ok',
      latencyMs: 1,
    });

    // The event the Meter wrote must be visible to a separate read of the sink.
    expect(sink.all()).toHaveLength(1);
  });
});
