// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {OAuth2IntrospectionService} from '../../introspection.service.js';
import type {FetchLike, OAuth2IntrospectionConfig} from '../../types.js';

interface Recorded {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

/**
 * Build a fake fetch that records the outgoing request and replies with the
 * given status + JSON body. `last` exposes what the service actually sent.
 */
function fakeFetch(
  status: number,
  payload: unknown,
): {fetch: FetchLike; last(): Recorded} {
  let recorded: Recorded | undefined;
  const fetch: FetchLike = async (input, init) => {
    recorded = {
      url: String(input),
      method: init?.method,
      headers: init?.headers ?? {},
      body:
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(String(init?.body ?? '')),
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    };
  };
  return {fetch, last: () => recorded!};
}

const baseConfig: OAuth2IntrospectionConfig = {
  introspectionUrl: 'https://as.example.com/introspect',
  clientId: 'rs-client',
  clientSecret: 'rs-secret',
};

describe('OAuth2IntrospectionService', () => {
  it('POSTs the token to the introspection endpoint and returns active claims', async () => {
    const {fetch, last} = fakeFetch(200, {
      active: true,
      sub: 'user-1',
      scope: 'widgets:read widgets:write',
    });
    const service = new OAuth2IntrospectionService(baseConfig, fetch);

    const claims = await service.introspect('opaque-token-abc');

    expect(claims.active).toBe(true);
    expect(claims.sub).toBe('user-1');
    expect(claims.scope).toBe('widgets:read widgets:write');

    const sent = last();
    expect(sent.url).toBe('https://as.example.com/introspect');
    expect(sent.method).toBe('POST');
    expect(sent.body.get('token')).toBe('opaque-token-abc');
    expect(sent.body.get('token_type_hint')).toBe('access_token');
  });

  it('authenticates to the endpoint with HTTP Basic by default', async () => {
    const {fetch, last} = fakeFetch(200, {active: true, sub: 'u'});
    const service = new OAuth2IntrospectionService(baseConfig, fetch);

    await service.introspect('t');

    const expected =
      'Basic ' + Buffer.from('rs-client:rs-secret').toString('base64');
    expect(last().headers.authorization).toBe(expected);
    // Credentials must NOT also leak into the body in basic mode.
    expect(last().body.get('client_id')).toBeNull();
  });

  it('sends client credentials in the body when clientAuthMethod is post', async () => {
    const {fetch, last} = fakeFetch(200, {active: true, sub: 'u'});
    const service = new OAuth2IntrospectionService(
      {...baseConfig, clientAuthMethod: 'post'},
      fetch,
    );

    await service.introspect('t');

    expect(last().headers.authorization).toBeUndefined();
    expect(last().body.get('client_id')).toBe('rs-client');
    expect(last().body.get('client_secret')).toBe('rs-secret');
  });

  it('throws 401 when the token is inactive', async () => {
    const {fetch} = fakeFetch(200, {active: false});
    const service = new OAuth2IntrospectionService(baseConfig, fetch);

    await expect(service.introspect('dead-token')).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('throws 401 on an empty token without calling the endpoint', async () => {
    let called = false;
    const fetch: FetchLike = async () => {
      called = true;
      return {ok: true, status: 200, json: async () => ({active: true})};
    };
    const service = new OAuth2IntrospectionService(baseConfig, fetch);

    await expect(service.introspect('')).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(called).toBe(false);
  });

  it('throws 503 when the introspection endpoint returns a non-2xx status', async () => {
    const {fetch} = fakeFetch(500, 'upstream boom');
    const service = new OAuth2IntrospectionService(baseConfig, fetch);

    await expect(service.introspect('t')).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('throws 503 when the introspection request itself fails (network error)', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const service = new OAuth2IntrospectionService(baseConfig, fetch);

    await expect(service.introspect('t')).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
