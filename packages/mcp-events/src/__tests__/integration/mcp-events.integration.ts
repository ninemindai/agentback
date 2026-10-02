// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {once} from 'node:events';
import https from 'node:https';
import type {AddressInfo} from 'node:net';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {
  AuthenticationBindings,
  type AuthRequest,
} from '@agentback/authentication';
import {
  event,
  MCPBindings,
  MCPComponent,
  MCPServer,
  mcpServer,
} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {RestApplication, type RestServer} from '@agentback/rest';
import {securityId} from '@agentback/security';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {installMcpEvents} from '../../install.js';
import {createPinnedTransport} from '../../pinned-transport.js';
import {generateWebhookSecret, verifyWebhook} from '../../signing.js';
import {HOOKS_TEST_CERT, HOOKS_TEST_KEY} from '../fixtures/tls.js';

const Filter = z.object({document_id: z.string()});
const Created = z.object({document_id: z.string(), comment_id: z.string()});

@mcpServer()
class DocEvents {
  @event('comment.created', {
    description: 'A comment was added to the document.',
    input: Filter,
    payload: Created,
  })
  matches(args: z.infer<typeof Filter>, e: z.infer<typeof Created>) {
    return e.document_id === args.document_id;
  }

  @event('doc.deleted', {payload: Filter, scope: 'docs:admin'})
  deleted() {
    return true;
  }
}

/** `x-user: <id>[;scope,scope]` authenticates; no header is anonymous. */
class HeaderStrategy {
  name = 'header';
  async authenticate(req: AuthRequest) {
    const raw = req.headerValue('x-user');
    if (!raw) return undefined;
    const [id, scopes = ''] = raw.split(';');
    return {
      [securityId]: id!,
      scopes: scopes ? scopes.split(',') : [],
    };
  }
}

interface Received {
  headers: Record<string, string | undefined>;
  body: string;
}

/** An `https://hooks.test` receiver on loopback that echoes challenges. */
async function receiver(opts: {echo?: boolean} = {}) {
  const received: Received[] = [];
  const server = https.createServer(
    {cert: HOOKS_TEST_CERT, key: HOOKS_TEST_KEY},
    (req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        received.push({
          headers: {
            'webhook-id': req.headers['webhook-id'] as string,
            'webhook-timestamp': req.headers['webhook-timestamp'] as string,
            'webhook-signature': req.headers['webhook-signature'] as string,
            'x-mcp-subscription-id': req.headers[
              'x-mcp-subscription-id'
            ] as string,
          },
          body,
        });
        const parsed = JSON.parse(body);
        if (parsed.type === 'verification') {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              challenge: opts.echo === false ? 'nope' : parsed.challenge,
            }),
          );
          return;
        }
        res.statusCode = 204;
        res.end();
      });
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    url: `https://hooks.test:${port}/in`,
    received,
    close: () => {
      server.closeAllConnections();
      return new Promise(r => server.close(r));
    },
  };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot() {
  const app = new RestApplication({rest: {port: 0, host: '127.0.0.1'}});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'events-it',
    version: '1.0.0',
    transports: {stdio: false},
  });
  app.service(DocEvents);
  app
    .bind('strategies.header')
    .toClass(HeaderStrategy)
    .tag(AuthenticationBindings.AUTH_STRATEGY);
  await app.get<MCPServer>('servers.MCPServer');
  await installMcpEvents(app, {
    // The receiver is on loopback and resolves through this map; the
    // transport still pins, and TLS still verifies `hooks.test`.
    transport: createPinnedTransport({
      allowPrivateAddresses: true,
      ca: HOOKS_TEST_CERT,
      resolve: async () => [{address: '127.0.0.1', family: 4}],
    }),
    backoffMs: 5,
  });
  await installMcpHttp(app, {
    strategyAuth: {strategy: 'header', required: false},
  });
  await app.start();
  cleanups.push(() => app.stop());
  const mcpUrl = new URL(
    (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
  );
  return {app, mcpUrl};
}

async function client(mcpUrl: URL, user: string | undefined, modern: boolean) {
  const c = new Client(
    {name: 'it', version: '0.0.0'},
    modern ? {versionNegotiation: {mode: 'auto' as const}} : {},
  );
  await c.connect(
    new StreamableHTTPClientTransport(mcpUrl, {
      requestInit: {headers: user ? {'x-user': user} : {}},
    }),
  );
  cleanups.push(() => c.close());
  return c;
}

const any = z.any();

describe('MCP Events over Streamable HTTP (stateless default)', () => {
  it.each([
    ['2025-era', false],
    ['2026-07-28', true],
  ])(
    'subscribe → verify → emit → signed delivery → unsubscribe (%s client)',
    async (_era, modern) => {
      const {app, mcpUrl} = await boot();
      const hook = await receiver();
      cleanups.push(hook.close);
      const secret = generateWebhookSecret();
      const c = await client(mcpUrl, 'alice', modern);

      const {events} = await c.request(
        {method: 'events/list', params: {}},
        any,
      );
      expect(events.map((e: {name: string}) => e.name)).toEqual([
        'comment.created',
      ]);

      const sub = await c.request(
        {
          method: 'events/subscribe',
          params: {
            name: 'comment.created',
            arguments: {document_id: 'd1'},
            delivery: {mode: 'webhook', url: hook.url, secret},
            ttlMs: 600_000,
          },
        },
        any,
      );
      expect(sub).toMatchObject({cursor: null, truncated: false});
      // The handshake already happened, signed and routed.
      expect(hook.received).toHaveLength(1);
      expect(JSON.parse(hook.received[0]!.body).type).toBe('verification');
      expect(hook.received[0]!.headers['x-mcp-subscription-id']).toBe(sub.id);

      const emitter = await app.get(MCPBindings.EVENTS);
      await emitter.emit(
        'comment.created',
        {document_id: 'd1', comment_id: 'c1'},
        {eventId: 'evt_it_1'},
      );
      // Filtered out by `match`: another document.
      await emitter.emit('comment.created', {
        document_id: 'd2',
        comment_id: 'c2',
      });
      await vi.waitFor(() => expect(hook.received).toHaveLength(2));
      const delivery = hook.received[1]!;
      expect(JSON.parse(delivery.body)).toMatchObject({
        eventId: 'evt_it_1',
        name: 'comment.created',
        data: {document_id: 'd1', comment_id: 'c1'},
        cursor: null,
      });
      expect(delivery.headers['webhook-id']).toBe('evt_it_1');
      expect(delivery.headers['x-mcp-subscription-id']).toBe(sub.id);
      expect(await verifyWebhook(secret, delivery.headers, delivery.body)).toBe(
        true,
      );

      await c.request(
        {
          method: 'events/unsubscribe',
          params: {
            name: 'comment.created',
            arguments: {document_id: 'd1'},
            delivery: {url: hook.url},
          },
        },
        any,
      );
      const after = await emitter.emit('comment.created', {
        document_id: 'd1',
        comment_id: 'c3',
      });
      expect(after.subscriptions).toBe(0);
    },
  );

  it('advertises events on server/discover (2026) and initialize (2025) on the wire', async () => {
    const {mcpUrl} = await boot();
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const discover = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'mcp-method': 'server/discover',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {name: 'raw', version: '0'},
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    expect(discover.status).toBe(200);
    expect(await jsonRpcResult(discover)).toMatchObject({
      capabilities: {events: {}},
    });
    const init = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: {name: 'raw', version: '0'},
        },
      }),
    });
    expect(await jsonRpcResult(init)).toMatchObject({
      capabilities: {events: {}},
    });
  });

  it('hides scoped events from, and refuses subscriptions by, an anonymous caller', async () => {
    const {mcpUrl} = await boot();
    const hook = await receiver();
    cleanups.push(hook.close);
    const anon = await client(mcpUrl, undefined, true);
    const names = (
      await anon.request({method: 'events/list', params: {}}, any)
    ).events.map((e: {name: string}) => e.name);
    expect(names).not.toContain('doc.deleted');
    await expect(
      anon.request(
        {
          method: 'events/subscribe',
          params: {
            name: 'comment.created',
            arguments: {document_id: 'd1'},
            delivery: {url: hook.url, secret: generateWebhookSecret()},
          },
        },
        any,
      ),
    ).rejects.toMatchObject({code: -32012});
    expect(hook.received).toHaveLength(0);

    const admin = await client(mcpUrl, 'root;docs:admin', true);
    const adminNames = (
      await admin.request({method: 'events/list', params: {}}, any)
    ).events.map((e: {name: string}) => e.name);
    expect(adminNames).toContain('doc.deleted');
  });

  it('refuses an endpoint that does not echo the challenge (-32015)', async () => {
    const {app, mcpUrl} = await boot();
    const hook = await receiver({echo: false});
    cleanups.push(hook.close);
    const c = await client(mcpUrl, 'alice', true);
    await expect(
      c.request(
        {
          method: 'events/subscribe',
          params: {
            name: 'comment.created',
            arguments: {document_id: 'd1'},
            delivery: {url: hook.url, secret: generateWebhookSecret()},
          },
        },
        any,
      ),
    ).rejects.toMatchObject({
      code: -32015,
      data: {reason: 'challenge_failed'},
    });
    const store = await app.get(MCPBindings.SUBSCRIPTION_STORE);
    expect(await store.listByEvent('comment.created')).toEqual([]);
  });
});

/** The JSON-RPC `result` of a POST answered as JSON or as one SSE event. */
async function jsonRpcResult(res: Response): Promise<unknown> {
  const text = await res.text();
  const json = text.trimStart().startsWith('{')
    ? text
    : text
        .split('\n')
        .find(l => l.startsWith('data:'))!
        .slice('data:'.length);
  return (JSON.parse(json) as {result: unknown}).result;
}
