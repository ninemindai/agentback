// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {once} from 'node:events';
import http from 'node:http';
import https from 'node:https';
import type {AddressInfo} from 'node:net';
import type {TLSSocket} from 'node:tls';
import {afterEach, describe, expect, it} from 'vitest';
import {
  createPinnedTransport,
  type ResolvedAddress,
} from '../../pinned-transport.js';
import {TransportError} from '../../transport.js';
import {HOOKS_TEST_CERT, HOOKS_TEST_KEY} from '../fixtures/tls.js';

interface Seen {
  host?: string;
  servername?: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise(r => s.close(r));
  }
});

async function listen(
  server: http.Server,
): Promise<{port: number; seen: Seen[]}> {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {port: (server.address() as AddressInfo).port, seen: []};
}

function handler(
  seen: Seen[],
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({
        host: req.headers.host,
        servername:
          (req.socket as TLSSocket & {servername?: string}).servername ||
          undefined,
        body,
        headers: req.headers,
      });
      respond(req, res);
    });
  };
}

async function httpServer(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const seen: Seen[] = [];
  const s = http.createServer(handler(seen, respond));
  const {port} = await listen(s);
  return {port, seen};
}

async function tlsServer(
  respond: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const seen: Seen[] = [];
  const s = https.createServer(
    {cert: HOOKS_TEST_CERT, key: HOOKS_TEST_KEY},
    handler(seen, respond),
  );
  const {port} = await listen(s as unknown as http.Server);
  return {port, seen};
}

const post = {
  headers: {'content-type': 'application/json', 'webhook-id': 'evt_1'},
  body: '{"hello":"world"}',
  timeoutMs: 2_000,
};

/** A resolver that maps every name to `addresses`, counting calls. */
function resolverTo(...addresses: string[]) {
  const calls: string[] = [];
  const resolve = async (name: string): Promise<ResolvedAddress[]> => {
    calls.push(name);
    return addresses.map(a => ({address: a, family: a.includes(':') ? 6 : 4}));
  };
  return {resolve, calls};
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TransportError);
    return (err as TransportError).reason;
  }
  throw new Error('expected a TransportError');
}

describe('createPinnedTransport', () => {
  it('pins the validated address while TLS and Host keep the hostname', async () => {
    const {port, seen} = await tlsServer((_q, r) => r.end('{"ok":true}'));
    const {resolve, calls} = resolverTo('127.0.0.1');
    const transport = createPinnedTransport({
      resolve,
      allowPrivateAddresses: true, // the receiver is on loopback
      ca: HOOKS_TEST_CERT,
    });
    const res = await transport({
      ...post,
      url: `https://hooks.test:${port}/in`,
    });
    expect(res).toEqual({status: 200, body: '{"ok":true}'});
    // Connected to 127.0.0.1 via our resolver, yet the certificate for
    // `hooks.test` verified: SNI and verification used the original name.
    expect(calls).toEqual(['hooks.test']);
    expect(seen[0]).toMatchObject({
      host: `hooks.test:${port}`,
      servername: 'hooks.test',
      body: post.body,
    });
    expect(seen[0]!.headers['webhook-id']).toBe('evt_1');
  });

  it('refuses a name that resolves to a non-public address, before connecting', async () => {
    const {port, seen} = await httpServer((_q, r) => r.end());
    const transport = createPinnedTransport({
      allowHttp: true,
      resolve: resolverTo('127.0.0.1').resolve,
    });
    expect(
      await reason(transport({...post, url: `http://hooks.test:${port}/`})),
    ).toBe('connection_refused');
    expect(seen).toHaveLength(0);
  });

  it('checks at connect time, so a rebinding name is caught on delivery', async () => {
    // Public when "subscribed", internal when delivered: each request
    // resolves afresh inside the socket's lookup and is judged then.
    let answer = '93.184.216.34';
    const resolve = async (): Promise<ResolvedAddress[]> => [
      {address: answer, family: 4},
    ];
    const transport = createPinnedTransport({allowHttp: true, resolve});
    answer = '169.254.169.254';
    expect(await reason(transport({...post, url: 'http://rebind.test/'}))).toBe(
      'connection_refused',
    );
  });

  it('refuses a mixed answer (any non-public address)', async () => {
    const transport = createPinnedTransport({
      allowHttp: true,
      resolve: resolverTo('93.184.216.34', '10.0.0.1').resolve,
    });
    expect(await reason(transport({...post, url: 'http://mixed.test/'}))).toBe(
      'connection_refused',
    );
  });

  it.each(['127.0.0.1', '[::1]', '169.254.169.254', '10.0.0.5'])(
    'refuses the IP literal %s (Node never calls lookup for one)',
    async host => {
      const transport = createPinnedTransport({allowHttp: true});
      expect(await reason(transport({...post, url: `http://${host}/`}))).toBe(
        'connection_refused',
      );
    },
  );

  it('refuses http unless explicitly allowed', async () => {
    const transport = createPinnedTransport({allowPrivateAddresses: true});
    expect(await reason(transport({...post, url: 'http://127.0.0.1:1/'}))).toBe(
      'connection_refused',
    );
  });

  it('never follows a redirect', async () => {
    const target = await httpServer((_q, r) => r.end('internal'));
    const {port, seen} = await httpServer((_q, r) => {
      r.statusCode = 302;
      r.setHeader('location', `http://127.0.0.1:${target.port}/`);
      r.end();
    });
    const transport = createPinnedTransport({
      allowHttp: true,
      allowPrivateAddresses: true,
    });
    const res = await transport({...post, url: `http://127.0.0.1:${port}/`});
    expect(res.status).toBe(302);
    expect(seen).toHaveLength(1);
    expect(target.seen).toHaveLength(0);
  });

  it('classifies a bad certificate as tls_error', async () => {
    const {port} = await tlsServer((_q, r) => r.end());
    const transport = createPinnedTransport({
      resolve: resolverTo('127.0.0.1').resolve,
      allowPrivateAddresses: true,
      // no `ca`: the self-signed certificate is untrusted
    });
    expect(
      await reason(transport({...post, url: `https://hooks.test:${port}/`})),
    ).toBe('tls_error');
  });

  it('times out a silent endpoint', async () => {
    const {port} = await httpServer(() => {
      /* never answers */
    });
    const transport = createPinnedTransport({
      allowHttp: true,
      allowPrivateAddresses: true,
    });
    const started = Date.now();
    expect(
      await reason(
        transport({...post, url: `http://127.0.0.1:${port}/`, timeoutMs: 100}),
      ),
    ).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('classifies a closed port as connection_refused', async () => {
    const {port} = await httpServer((_q, r) => r.end());
    for (const s of servers.splice(0)) {
      await new Promise(r => s.close(r));
    }
    const transport = createPinnedTransport({
      allowHttp: true,
      allowPrivateAddresses: true,
    });
    expect(
      await reason(transport({...post, url: `http://127.0.0.1:${port}/`})),
    ).toBe('connection_refused');
  });

  it('reads at most maxResponseBytes of the response', async () => {
    const {port} = await httpServer((_q, r) => r.end('x'.repeat(100_000)));
    const transport = createPinnedTransport({
      allowHttp: true,
      allowPrivateAddresses: true,
      maxResponseBytes: 1_000,
    });
    const res = await transport({...post, url: `http://127.0.0.1:${port}/`});
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(1_000);
  });
});
