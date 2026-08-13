// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * installRateLimit returns an Installed (docs/proposals/revertible-installs.md,
 * wave 5): the limiter is a bare middleware (no route of its own), so the
 * observable retraction is that a caller who exhausted the limit stops being
 * throttled once the gate is off.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {RestApplication} from '@agentback/rest';
import {installRateLimit} from '../../index.js';

describe('installRateLimit uninstall', () => {
  let app: RestApplication;

  afterEach(async () => app.stop());

  it('stops limiting after uninstall', async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    const installed = await installRateLimit(app, {points: 1, durationSecs: 60});
    await app.start();
    const server = await app.restServer;
    const url = `${server.url}/openapi.json`;

    expect((await fetch(url)).status).toBe(200);
    expect((await fetch(url)).status).toBe(429); // budget of 1 exhausted

    await installed.uninstall();

    expect((await fetch(url)).status).toBe(200); // limiter is gone
    await expect(installed.uninstall()).resolves.toBeUndefined();
  });
});
