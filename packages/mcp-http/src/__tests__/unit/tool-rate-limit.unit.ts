// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import type {Request, Response} from 'express';
import {toolRateLimitMiddleware} from '../../tool-rate-limit.js';

interface RunResult {
  nextCalled: boolean;
  status?: number;
  body?: {jsonrpc?: string; error?: {code?: number}; id?: unknown};
  headers: Record<string, string>;
}

function run(
  mw: ReturnType<typeof toolRateLimitMiddleware>,
  body: unknown,
): Promise<RunResult> {
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
        resolve({
          nextCalled: false,
          status,
          body: b as RunResult['body'],
          headers,
        });
        return res;
      },
    } as unknown as Response;
    const req = {body, ip: '1.2.3.4'} as unknown as Request;
    mw(req, res, () => resolve({nextCalled: true, status, headers}));
  });
}

const call = (name: string, id = 1) => ({
  jsonrpc: '2.0',
  method: 'tools/call',
  params: {name},
  id,
});

describe('toolRateLimitMiddleware', () => {
  it('limits a tool per caller, then 429s with a JSON-RPC error', async () => {
    const mw = toolRateLimitMiddleware({
      points: 2,
      durationSecs: 60,
      keyGenerator: () => 'c1',
    });
    expect((await run(mw, call('t'))).nextCalled).toBe(true);
    expect((await run(mw, call('t'))).nextCalled).toBe(true);
    const r3 = await run(mw, call('t', 7));
    expect(r3.status).toBe(429);
    expect(r3.body?.jsonrpc).toBe('2.0');
    expect(r3.body?.error?.code).toBe(-32029);
    expect(r3.body?.id).toBe(7);
    expect(r3.headers['Retry-After']).toBeDefined();
  });

  it('gives each tool its own bucket', async () => {
    const mw = toolRateLimitMiddleware({points: 1, keyGenerator: () => 'c'});
    expect((await run(mw, call('a'))).nextCalled).toBe(true);
    expect((await run(mw, call('b'))).nextCalled).toBe(true); // different tool
    expect((await run(mw, call('a'))).status).toBe(429); // 'a' exhausted
  });

  it('applies per-tool overrides', async () => {
    const mw = toolRateLimitMiddleware({
      points: 5,
      perTool: {strict: {points: 1}},
      keyGenerator: () => 'c',
    });
    expect((await run(mw, call('strict'))).nextCalled).toBe(true);
    expect((await run(mw, call('strict'))).status).toBe(429); // override = 1
    expect((await run(mw, call('loose'))).nextCalled).toBe(true); // default = 5
  });

  it('ignores non-tools/call methods', async () => {
    const mw = toolRateLimitMiddleware({points: 1, keyGenerator: () => 'c'});
    expect((await run(mw, {method: 'tools/list', id: 1})).nextCalled).toBe(
      true,
    );
    expect((await run(mw, {method: 'tools/list', id: 2})).nextCalled).toBe(
      true,
    );
    expect((await run(mw, {method: 'initialize', id: 3})).nextCalled).toBe(
      true,
    );
  });
});
