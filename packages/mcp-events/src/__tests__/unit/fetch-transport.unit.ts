// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {fetchTransport, TransportError} from '../../transport.js';

const post = {headers: {}, body: '{}', timeoutMs: 1_000};

describe('fetchTransport', () => {
  it.each([
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://169.254.169.254/latest',
    'https://10.0.0.1/',
    'https://localhost/',
    'https://LOCALHOST./',
    'https://api.localhost/',
  ])('refuses %s before calling fetch', async url => {
    let called = false;
    const transport = fetchTransport(async () => {
      called = true;
      return new Response('');
    });
    const err = await transport({...post, url}).catch(e => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(err.reason).toBe('connection_refused');
    expect(called).toBe(false);
  });

  it('posts to a public host and reports a redirect as a 3xx', async () => {
    const seen: RequestInit[] = [];
    const transport = fetchTransport(async (_url, init) => {
      seen.push(init!);
      return new Response(null, {status: 302, headers: {location: '/x'}});
    });
    const res = await transport({...post, url: 'https://hooks.example.com/'});
    expect(res.status).toBe(302);
    expect(seen[0]).toMatchObject({method: 'POST', redirect: 'manual'});
  });

  it('allows a private address when told to (development only)', async () => {
    const transport = fetchTransport(async () => new Response('ok'), {
      allowPrivateAddresses: true,
    });
    await expect(
      transport({...post, url: 'https://127.0.0.1/'}),
    ).resolves.toEqual({status: 200, body: 'ok'});
  });
});
