// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {verifyDeploy} from '../../verify.js';

function stub(status: number, body: string): typeof fetch {
  return (async (input: any) => {
    void input;
    return new Response(body, {status});
  }) as unknown as typeof fetch;
}

describe('verifyDeploy', () => {
  it('passes on 200', async () => {
    const r = await verifyDeploy(
      'https://x.vercel.app',
      {verifyPath: '/openapi.json'},
      stub(200, '{"openapi":"3.1.1"}'),
    );
    expect(r).toMatchObject({ok: true, status: 200});
  });

  it('fails on non-200 and returns body', async () => {
    const r = await verifyDeploy(
      'https://x.vercel.app',
      {verifyPath: '/openapi.json'},
      stub(500, 'boom'),
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
    expect(r.body).toContain('boom');
  });

  it('honors a custom verify path', async () => {
    let seen = '';
    const fetchFn = (async (input: any) => {
      seen = String(input);
      return new Response('{}', {status: 200});
    }) as unknown as typeof fetch;
    await verifyDeploy(
      'https://x.vercel.app',
      {verifyPath: '/v1/openapi.json'},
      fetchFn,
    );
    expect(seen).toBe('https://x.vercel.app/v1/openapi.json');
  });

  it('returns ok:false when fetch throws (e.g. timeout)', async () => {
    const throwingFetch = (async () => {
      throw new Error('The operation was aborted.');
    }) as unknown as typeof fetch;
    const r = await verifyDeploy(
      'https://x.vercel.app',
      {verifyPath: '/openapi.json'},
      throwingFetch,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.body).toContain('aborted');
  });
});
