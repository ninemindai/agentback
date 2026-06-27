// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import type {Request, RequestHandler, Response} from 'express';
import {createRateLimitMiddleware} from '../../index.js';

interface RunResult {
  nextCalled: boolean;
  status?: number;
  headers: Record<string, string>;
  body?: unknown;
}

/** Invoke the middleware once and resolve when it calls next() or responds. */
function run(mw: RequestHandler, req: Partial<Request>): Promise<RunResult> {
  return new Promise(resolve => {
    const headers: Record<string, string> = {};
    let status: number | undefined;
    const res = {
      set(k: string, v: string) {
        headers[k] = String(v);
        return res;
      },
      status(c: number) {
        status = c;
        return res;
      },
      json(b: unknown) {
        resolve({nextCalled: false, status, headers, body: b});
        return res;
      },
    } as unknown as Response;
    mw(req as Request, res, () => resolve({nextCalled: true, status, headers}));
  });
}

describe('createRateLimitMiddleware', () => {
  it('allows up to the limit, then responds 429', async () => {
    const mw = createRateLimitMiddleware({
      points: 2,
      durationSecs: 60,
      keyGenerator: () => 'k1',
    });
    const req = {ip: '1.2.3.4'};
    const r1 = await run(mw, req);
    const r2 = await run(mw, req);
    const r3 = await run(mw, req);

    expect(r1.nextCalled).toBe(true);
    expect(r2.nextCalled).toBe(true);
    expect(r3.nextCalled).toBe(false);
    expect(r3.status).toBe(429);
    expect(r3.body).toEqual({
      error: {statusCode: 429, message: 'Too many requests'},
    });
  });

  it('emits RateLimit headers (and Retry-After when limited)', async () => {
    const mw = createRateLimitMiddleware({points: 1, keyGenerator: () => 'k2'});
    const ok = await run(mw, {ip: 'x'});
    const limited = await run(mw, {ip: 'x'});

    expect(ok.headers['RateLimit-Limit']).toBe('1');
    expect(ok.headers['RateLimit-Remaining']).toBe('0');
    expect(limited.status).toBe(429);
    expect(limited.headers['Retry-After']).toBeDefined();
  });

  it('keys are independent buckets', async () => {
    const mw = createRateLimitMiddleware({
      points: 1,
      keyGenerator: (req: Request) => req.ip ?? 'unknown',
    });
    expect((await run(mw, {ip: 'a'})).nextCalled).toBe(true);
    expect((await run(mw, {ip: 'b'})).nextCalled).toBe(true); // different key
    expect((await run(mw, {ip: 'a'})).status).toBe(429); // 'a' exhausted
  });

  it('skip() bypasses limiting entirely', async () => {
    const mw = createRateLimitMiddleware({
      points: 1,
      keyGenerator: () => 'k3',
      skip: () => true,
    });
    expect((await run(mw, {})).nextCalled).toBe(true);
    expect((await run(mw, {})).nextCalled).toBe(true); // still allowed
  });

  it('honors a custom status code', async () => {
    const mw = createRateLimitMiddleware({
      points: 1,
      keyGenerator: () => 'k4',
      statusCode: 503,
      message: 'slow down',
    });
    await run(mw, {});
    const limited = await run(mw, {});
    expect(limited.status).toBe(503);
    expect(limited.body).toEqual({
      error: {statusCode: 503, message: 'slow down'},
    });
  });
});
