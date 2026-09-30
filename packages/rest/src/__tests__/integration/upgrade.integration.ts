// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * `RestServer.upgrade(path, handler)` accepts HTTP `Upgrade` (WebSocket)
 * connections on the port the REST routes are served from. Node never routes an
 * upgrade through the request handler — it emits `'upgrade'` on the server with
 * the raw socket — so this is the only supported way to put a `ws` endpoint on
 * the app's own port. Every case runs on both listeners.
 */

import {afterEach, describe, expect, it} from 'vitest';
import net from 'node:net';
import {z} from 'zod';
import WebSocket, {WebSocketServer} from 'ws';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import type {RestServer} from '../../rest.server.js';

const PingOut = z.object({pong: z.boolean()});

@api({})
class PingController {
  @get('/ping', {response: PingOut})
  async ping(): Promise<z.infer<typeof PingOut>> {
    return {pong: true};
  }
}

/** A `ws` server in `noServer` mode that echoes every message back. */
function echoServer(): WebSocketServer {
  const wss = new WebSocketServer({noServer: true});
  wss.on('connection', ws => ws.on('message', m => ws.send(`echo:${m}`)));
  return wss;
}

function acceptWith(wss: WebSocketServer) {
  return (
    req: Parameters<WebSocketServer['handleUpgrade']>[0],
    socket: Parameters<WebSocketServer['handleUpgrade']>[1],
    head: Parameters<WebSocketServer['handleUpgrade']>[2],
  ) => wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
}

/** Open a `ws` client, send one message, resolve with the reply. */
async function roundTrip(url: string, text: string): Promise<string> {
  const ws = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const reply = new Promise<string>(resolve =>
      ws.once('message', m => resolve(String(m))),
    );
    ws.send(text);
    return await reply;
  } finally {
    ws.terminate();
  }
}

/**
 * Write raw bytes and collect the response until the server closes the socket.
 * Rejects if it is still open after `ms` — every case here expects a close.
 */
function rawExchange(url: string, request: string, ms = 2000): Promise<string> {
  const {hostname, port} = new URL(url);
  return new Promise((resolve, reject) => {
    const s = net.connect(Number(port), hostname);
    let buf = '';
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`socket still open after ${ms}ms; got ${buf}`));
    }, ms);
    s.on('data', d => (buf += d));
    s.on('error', () => {});
    s.on('close', () => {
      clearTimeout(timer);
      resolve(buf);
    });
    s.write(request);
  });
}

const upgradeRequest = (target: string) =>
  `GET ${target} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n` +
  `Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n` +
  `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`;

describe.each(['express', 'native'] as const)(
  'RestServer.upgrade (listener: %s)',
  listener => {
    let app: RestApplication | undefined;
    const cleanups: Array<() => void> = [];

    afterEach(async () => {
      await app?.stop();
      app = undefined;
      for (const c of cleanups.splice(0)) c();
    });

    async function makeApp(): Promise<RestServer> {
      app = new RestApplication({
        rest: {port: 0, host: '127.0.0.1', listener},
      });
      app.restController(PingController);
      return app.getServer<RestServer>('RestServer');
    }

    function wsUrl(server: RestServer, path: string): string {
      return server.url.replace(/^http/, 'ws') + path;
    }

    function track(wss: WebSocketServer): WebSocketServer {
      cleanups.push(() => wss.close());
      return wss;
    }

    it('round-trips a message on a registered path beside REST routes', async () => {
      const server = await makeApp();
      server.upgrade('/ws', acceptWith(track(echoServer())));
      await app!.start();

      expect(await roundTrip(wsUrl(server, '/ws'), 'hi')).toBe('echo:hi');
      // A query string does not defeat the match.
      expect(await roundTrip(wsUrl(server, '/ws?token=t'), 'q')).toBe('echo:q');
      const res = await fetch(`${server.url}/ping`);
      expect(await res.json()).toEqual({pong: true});
    });

    it('answers 404 and closes an upgrade on an unregistered path', async () => {
      const server = await makeApp();
      server.upgrade('/ws', acceptWith(track(echoServer())));
      await app!.start();

      const reply = await rawExchange(server.url, upgradeRequest('/other'));
      expect(reply).toMatch(/^HTTP\/1\.1 404 /);
      // Matching is exact, not by prefix.
      const nested = await rawExchange(server.url, upgradeRequest('/ws/x'));
      expect(nested).toMatch(/^HTTP\/1\.1 404 /);
    });

    it('leaves upgrade requests to the request handler when none is registered', async () => {
      const server = await makeApp();
      await app!.start();

      // Node downgrades an upgrade with no 'upgrade' listener to a plain
      // request, so the REST route answers — today's behaviour, unchanged.
      const reply = await rawExchange(
        server.url,
        upgradeRequest('/ping').replace(
          '\r\n\r\n',
          '\r\nConnection: close\r\n\r\n',
        ),
      );
      expect(reply).toMatch(/^HTTP\/1\.1 200 /);
      expect(reply).toContain('"pong":true');
    });

    it('survives a malformed request-target and still accepts a good upgrade', async () => {
      const server = await makeApp();
      server.upgrade('/ws', acceptWith(track(echoServer())));
      await app!.start();

      await rawExchange(server.url, upgradeRequest('http://['));
      expect(await roundTrip(wsUrl(server, '/ws'), 'ok')).toBe('echo:ok');
    });

    it('survives a handler that throws or rejects', async () => {
      const server = await makeApp();
      server.upgrade('/sync', () => {
        throw new Error('boom');
      });
      server.upgrade('/async', async () => {
        throw new Error('async boom');
      });
      server.upgrade('/ws', acceptWith(track(echoServer())));
      await app!.start();

      await rawExchange(server.url, upgradeRequest('/sync'));
      await rawExchange(server.url, upgradeRequest('/async'));
      expect(await roundTrip(wsUrl(server, '/ws'), 'ok')).toBe('echo:ok');
    });

    it('throws when registered after start()', async () => {
      const server = await makeApp();
      await app!.start();
      expect(() => server.upgrade('/late', () => {})).toThrow(
        /before start\(\)/,
      );
    });

    it('refuses a second handler for the same path', async () => {
      const server = await makeApp();
      server.upgrade('/ws', () => {});
      expect(() => server.upgrade('/ws', () => {})).toThrow(/already/);
    });

    it('retracts a path through the returned remover', async () => {
      const server = await makeApp();
      const remove = server.upgrade('/ws', acceptWith(track(echoServer())));
      server.upgrade('/keep', acceptWith(track(echoServer())));
      await app!.start();

      remove();
      const reply = await rawExchange(server.url, upgradeRequest('/ws'));
      expect(reply).toMatch(/^HTTP\/1\.1 404 /);
    });

    it('stop() ends an open connection even with no close hook', async () => {
      const server = await makeApp();
      server.upgrade('/ws', acceptWith(track(echoServer())));
      await app!.start();

      const ws = new WebSocket(wsUrl(server, '/ws'));
      await new Promise(resolve => ws.once('open', resolve));
      const closed = new Promise(resolve => ws.once('close', resolve));

      // An upgraded socket is no longer an HTTP connection, so without the
      // framework ending it `server.close()` would wait on it forever.
      await app!.stop();
      app = undefined;
      await closed;
    });

    it('stop() runs the close hook before ending what is left', async () => {
      const server = await makeApp();
      const wss = echoServer();
      const events: string[] = [];
      server.upgrade('/ws', acceptWith(wss), {
        close: async () => {
          events.push(`hook:${wss.clients.size}`);
          for (const client of wss.clients) client.close(1001, 'shutdown');
          await new Promise<void>(resolve => wss.close(() => resolve()));
        },
      });
      await app!.start();

      const ws = new WebSocket(wsUrl(server, '/ws'));
      await new Promise(resolve => ws.once('open', resolve));
      const code = new Promise<number>(resolve =>
        ws.once('close', c => resolve(c)),
      );

      await app!.stop();
      app = undefined;
      expect(events).toEqual(['hook:1']);
      // The hook's graceful close reached the client before the sweep.
      expect(await code).toBe(1001);
    });
  },
);
