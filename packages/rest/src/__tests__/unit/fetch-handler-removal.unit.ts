// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * addFetchHandler / addFetchPrefix return removers — the fetch-host half of
 * the revertible-install contract (docs/proposals/revertible-installs.md):
 * an install helper that registered a handler can retract exactly that
 * handler, after which the route falls through to 404 again.
 */

import {describe, expect, it} from 'vitest';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';

async function makeServer(): Promise<RestServer> {
  const app = new RestApplication({rest: {listener: 'native'}});
  return app.restServer;
}

describe('fetch handler removal', () => {
  it('addFetchHandler returns a remover that makes the exact route 404 again', async () => {
    const server = await makeServer();
    const remove = server.addFetchHandler(
      'GET',
      '/widget',
      async () => new Response('live'),
    );

    const before = await server
      .fetchHandler()
      .fetch(new Request('http://x/widget'));
    expect(before.status).toBe(200);
    expect(await before.text()).toBe('live');

    remove();

    const after = await server
      .fetchHandler()
      .fetch(new Request('http://x/widget'));
    expect(after.status).toBe(404);
  });

  it('addFetchPrefix returns a remover that makes the prefix 404 again', async () => {
    const server = await makeServer();
    const remove = server.addFetchPrefix('/assets', async suffix =>
      suffix === '/app.js' ? new Response('js') : undefined,
    );

    const before = await server
      .fetchHandler()
      .fetch(new Request('http://x/assets/app.js'));
    expect(before.status).toBe(200);

    remove();

    const after = await server
      .fetchHandler()
      .fetch(new Request('http://x/assets/app.js'));
    expect(after.status).toBe(404);
  });

  it('removing one handler leaves others in place', async () => {
    const server = await makeServer();
    const removeA = server.addFetchHandler(
      'GET',
      '/a',
      async () => new Response('a'),
    );
    server.addFetchHandler('GET', '/b', async () => new Response('b'));

    removeA();

    const a = await server.fetchHandler().fetch(new Request('http://x/a'));
    const b = await server.fetchHandler().fetch(new Request('http://x/b'));
    expect(a.status).toBe(404);
    expect(b.status).toBe(200);
  });
});
