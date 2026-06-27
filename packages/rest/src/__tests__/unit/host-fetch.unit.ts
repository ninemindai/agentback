// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Router} from '../../web/router.js';
import {createFetchHost} from '../../host/fetch.js';

describe('createFetchHost', () => {
  it('routes a matched request to dispatch with params', async () => {
    const router = new Router<string>();
    router.add({method: 'GET', template: '/greet/{name}', value: 'greet'});
    const host = createFetchHost({
      router,
      dispatch: async match =>
        Response.json({value: match.value, params: match.params}),
    });
    const res = await host.fetch(
      new Request('http://x/greet/Ada', {method: 'GET'}),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({value: 'greet', params: {name: 'Ada'}});
  });

  it('returns the nested 404 envelope when nothing matches', async () => {
    const host = createFetchHost({
      router: new Router<string>(),
      dispatch: async () => Response.json({}),
    });
    const res = await host.fetch(new Request('http://x/missing'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {code: 'not_found', message: 'Not Found'},
    });
  });

  it('honors a custom notFound handler', async () => {
    const host = createFetchHost({
      router: new Router<string>(),
      dispatch: async () => Response.json({}),
      notFound: () => new Response('nope', {status: 418}),
    });
    const res = await host.fetch(new Request('http://x/missing'));
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('nope');
  });
});
