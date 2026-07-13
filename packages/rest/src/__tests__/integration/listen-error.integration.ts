// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * A bind failure (EADDRINUSE / EACCES) must surface as a rejected `start()`,
 * not a silent false-success. Express 5's `app.listen(port, host, cb)` fires
 * `cb` even when the bind fails (with `address() === null`) and only *then*
 * emits `'error'`, so resolving on that callback reports a server that never
 * bound — the caller prints "listening" and the process exits 0 with no error.
 * RestServer must resolve on the real `'listening'` event and reject on `'error'`.
 */

import {afterEach, describe, expect, it} from 'vitest';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';

const PingOut = z.object({pong: z.boolean()});

@api({})
class PingController {
  @get('/ping', {response: PingOut})
  async ping(): Promise<z.infer<typeof PingOut>> {
    return {pong: true};
  }
}

/** Hold an ephemeral port so the app under test is guaranteed a bind conflict. */
async function holdPort(): Promise<{port: number; release: () => Promise<void>}> {
  const holder = http.createServer();
  await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', () => resolve()));
  const {port} = holder.address() as AddressInfo;
  return {
    port,
    release: () => new Promise<void>(resolve => holder.close(() => resolve())),
  };
}

describe('RestServer — bind failure surfaces as a rejected start()', () => {
  let release: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await release?.();
    release = undefined;
  });

  it('rejects (Express host) when the port is already in use', async () => {
    const held = await holdPort();
    release = held.release;
    const app = new RestApplication({rest: {port: held.port, host: '127.0.0.1'}});
    app.restController(PingController);
    await expect(app.start()).rejects.toThrow(/EADDRINUSE/);
    // And the app must not report a live listener after a failed bind.
    const server = await app.restServer;
    expect(server.listening).toBe(false);
  });

  it("rejects (native host) when the port is already in use", async () => {
    const held = await holdPort();
    release = held.release;
    const app = new RestApplication({
      rest: {port: held.port, host: '127.0.0.1', listener: 'native'},
    });
    app.restController(PingController);
    await expect(app.start()).rejects.toThrow(/EADDRINUSE/);
  });
});
