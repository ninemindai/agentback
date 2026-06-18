// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {InMemoryUsageSink} from '../../in-memory-sink.js';
import {InMemoryQuotaService} from '../../quota.js';
import {statusOf} from '../../status.js';
import {Meter} from '../../meter.js';
import type {UsageDescriptor} from '../../types.js';

const desc = (over: Partial<UsageDescriptor> = {}): UsageDescriptor => ({
  surface: 'rest',
  operation: 'WidgetController.list',
  principal: {kind: 'client', id: 'svc-1'},
  ...over,
});

/** A Meter with a frozen clock and deterministic ids for assertions. */
function meterWith(sink: InMemoryUsageSink, startMs = 1_000) {
  let n = 0;
  let nowMs = startMs;
  const meter = new Meter(sink, {
    now: () => nowMs,
    genId: () => `evt-${n++}`,
  });
  return {meter, advance: (ms: number) => (nowMs += ms)};
}

describe('statusOf', () => {
  it('maps HTTP error codes to billing-relevant statuses', () => {
    expect(statusOf(undefined)).toBe('ok');
    expect(statusOf({statusCode: 401})).toBe('denied');
    expect(statusOf({statusCode: 403})).toBe('denied');
    expect(statusOf({statusCode: 429})).toBe('rate_limited');
    expect(statusOf({statusCode: 402})).toBe('payment_required');
    expect(statusOf({statusCode: 500})).toBe('error');
    expect(statusOf(new Error('boom'))).toBe('error'); // no statusCode → error
  });
});

describe('InMemoryUsageSink', () => {
  it('records events and exposes them by principal', async () => {
    const sink = new InMemoryUsageSink();
    const {meter} = meterWith(sink);
    await meter.record({...desc(), status: 'ok', latencyMs: 5});
    await meter.record({
      ...desc({principal: {kind: 'user', id: 'alice'}}),
      status: 'ok',
      latencyMs: 7,
    });
    expect(sink.all()).toHaveLength(2);
    expect(sink.forPrincipal('alice')).toHaveLength(1);
    expect(sink.forPrincipal('svc-1')[0].operation).toBe(
      'WidgetController.list',
    );
  });

  it('is idempotent on event id', async () => {
    const sink = new InMemoryUsageSink();
    const e = {
      id: 'dup',
      at: 'now',
      status: 'ok' as const,
      latencyMs: 1,
      units: 1,
      surface: 'rest' as const,
      operation: 'x',
      principal: {kind: 'client' as const, id: 'c'},
    };
    await sink.record(e);
    await sink.record(e);
    expect(sink.all()).toHaveLength(1);
  });
});

describe('Meter.record', () => {
  it('stamps id, ISO time, and defaults units to 1', async () => {
    const sink = new InMemoryUsageSink();
    const {meter} = meterWith(sink, 0);
    await meter.record({...desc(), status: 'ok', latencyMs: 3});
    const [e] = sink.all();
    expect(e.id).toBe('evt-0');
    expect(e.at).toBe(new Date(0).toISOString());
    expect(e.units).toBe(1);
    expect(e.status).toBe('ok');
  });

  it('honors an explicit units count', async () => {
    const sink = new InMemoryUsageSink();
    const {meter} = meterWith(sink);
    await meter.record({...desc({units: 4}), status: 'ok', latencyMs: 1});
    expect(sink.all()[0].units).toBe(4);
  });
});

describe('Meter.observe', () => {
  it('emits an ok event with measured latency and returns the result', async () => {
    const sink = new InMemoryUsageSink();
    const {meter, advance} = meterWith(sink);
    const result = await meter.observe(desc(), async () => {
      advance(12);
      return 'value';
    });
    expect(result).toBe('value');
    const [e] = sink.all();
    expect(e.status).toBe('ok');
    expect(e.latencyMs).toBe(12);
  });

  it('emits a status-mapped event and rethrows on failure', async () => {
    const sink = new InMemoryUsageSink();
    const {meter, advance} = meterWith(sink);
    const err = Object.assign(new Error('nope'), {statusCode: 429});
    await expect(
      meter.observe(desc(), async () => {
        advance(4);
        throw err;
      }),
    ).rejects.toBe(err);
    const [e] = sink.all();
    expect(e.status).toBe('rate_limited');
    expect(e.latencyMs).toBe(4);
  });

  it('resolves a lazy descriptor at record time (principal known only mid-call)', async () => {
    const sink = new InMemoryUsageSink();
    const {meter} = meterWith(sink);
    // The principal is unknown until `fn` runs (mirrors REST auth inside dispatch).
    let principalId = 'unset';
    await meter.observe(
      () => desc({principal: {kind: 'client', id: principalId}}),
      async () => {
        principalId = 'svc-resolved';
        return 'ok';
      },
    );
    expect(sink.all()[0].principal.id).toBe('svc-resolved');
  });
});

describe('InMemoryQuotaService', () => {
  it('allows by default when no limit is set', async () => {
    const q = new InMemoryQuotaService();
    expect(await q.check('anyone')).toEqual({allowed: true});
  });

  it('enforces a per-principal limit and reports remaining', async () => {
    const q = new InMemoryQuotaService({limits: {'svc-1': 3}});
    await q.consume('svc-1', 2);
    expect(await q.check('svc-1')).toEqual({allowed: true, remaining: 1});
    await q.consume('svc-1', 1);
    expect(await q.check('svc-1')).toEqual({allowed: false, remaining: 0});
  });

  it('tracks principals independently', async () => {
    const q = new InMemoryQuotaService({limits: {a: 1, b: 1}});
    await q.consume('a', 1);
    expect((await q.check('a')).allowed).toBe(false);
    expect((await q.check('b')).allowed).toBe(true);
  });
});
