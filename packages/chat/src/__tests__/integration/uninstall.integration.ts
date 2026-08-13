// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * installChat returns a ChatHttpHandle that is also an Installed
 * (docs/proposals/revertible-installs.md, wave 4): uninstall() retracts the
 * webhook routes, shuts the chat runtime down, and deregisters the onStop
 * hook so a later stop() doesn't shut down twice.
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {RestApplication} from '@agentback/rest';
import {ChatComponent} from '../../chat.component.js';
import {installChat} from '../../install.js';
import type {ChatLike} from '../../port.js';

function makeChat(): {chat: ChatLike; shutdown: ReturnType<typeof vi.fn>} {
  const shutdown = vi.fn(async () => {});
  const chat: ChatLike = {
    webhooks: {
      fake: async () => new Response('ok', {status: 200}),
    },
    shutdown,
  };
  return {chat, shutdown};
}

describe('installChat uninstall', () => {
  let app: RestApplication;

  afterEach(async () => app.stop());

  it('retracts the webhook route, shuts down once, and is idempotent', async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(ChatComponent);
    const {chat, shutdown} = makeChat();
    const handle = await installChat(app, {chat});
    await app.start();
    const server = await app.restServer;

    const before = await fetch(`${server.url}${handle.paths.fake}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
    expect(before.status).toBe(200);

    await handle.uninstall();

    const after = await fetch(`${server.url}${handle.paths.fake}`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: '{}',
    });
    expect(after.status).toBe(404);
    expect(shutdown).toHaveBeenCalledTimes(1);

    await expect(handle.uninstall()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalledTimes(1);

    // stop() after uninstall must not shut down a second time (the onStop
    // hook was deregistered).
    await app.stop();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });
});
