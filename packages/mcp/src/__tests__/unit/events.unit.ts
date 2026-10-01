// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {authorize} from '@agentback/authorization';
import {inject} from '@agentback/context';
import {Application} from '@agentback/core';
import {
  securityId,
  SecurityBindings,
  type UserProfile,
} from '@agentback/security';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import type {AuthInfo} from '@modelcontextprotocol/server';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {event, mcpServer, tool} from '../../decorators/index.js';
import {MCPBindings} from '../../keys.js';
import type {MCPServerConfig} from '../../types.js';
import {
  CallbackEndpointError,
  McpEventErrorCodes,
  type EventDelivery,
  type EventOccurrence,
  type EventSubscription,
  type VerificationTarget,
} from '../../events/ports.js';
import {InMemorySubscriptionStore} from '../../events/in-memory-store.js';
import {
  grantTtl,
  isWebhookSecret,
  resolveEventsConfig,
  subscriptionId,
} from '../../events/subscriptions.js';

const SECRET = `whsec_${btoa('k'.repeat(32))}`;
const SECRET2 = `whsec_${btoa('n'.repeat(32))}`;
const URL1 = 'https://hooks.example.com/a';

const Filter = z.object({document_id: z.string()});
const Created = z.object({
  document_id: z.string(),
  comment_id: z.string(),
  text: z.string(),
});

@mcpServer()
class DocEvents {
  @event('comment.created', {
    description: 'A new review comment was added to the document.',
    input: Filter,
    payload: Created,
  })
  matches(args: z.infer<typeof Filter>, e: z.infer<typeof Created>) {
    return e.document_id === args.document_id;
  }

  @event('doc.archived', {
    payload: z.object({document_id: z.string()}),
    scope: 'docs:admin',
  })
  archived() {
    return true;
  }

  @event('doc.touched', {payload: z.object({by: z.string()})})
  touched(
    _args: Record<string, never>,
    _e: {by: string},
    @inject(SecurityBindings.USER) user: UserProfile,
  ) {
    // The subscriber is bound while `match` runs.
    return user[securityId] !== 'blocked';
  }

  @event('doc.sloppy', {payload: z.object({n: z.number()})})
  sloppy() {
    // Not a boolean: never a match.
    return 'yes' as unknown as boolean;
  }

  @event('doc.throws', {payload: z.object({n: z.number()})})
  throws(_a: Record<string, never>, e: {n: number}): boolean {
    if (e.n === 1) throw new Error('boom');
    return true;
  }

  @tool('ping')
  ping() {
    return 'pong';
  }
}

@mcpServer()
class GatedEvents {
  @authorize({allowedRoles: ['auditor']})
  @event('audit.logged', {payload: z.object({line: z.string()})})
  logged() {
    return true;
  }
}

/** Records every verify/deliver; can be told to fail verification. */
class FakeDelivery implements EventDelivery {
  verified: VerificationTarget[] = [];
  delivered: {sub: EventSubscription; occurrence: EventOccurrence}[] = [];
  failWith?: Error;

  async verify(target: VerificationTarget): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.verified.push(target);
  }

  async deliver(sub: EventSubscription, occurrence: EventOccurrence) {
    this.delivered.push({sub, occurrence});
  }
}

let app: Application | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function givenServer(
  cfg: Partial<MCPServerConfig> = {},
  opts: {delivery?: EventDelivery | false; classes?: Function[]} = {},
) {
  app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'events-test',
    version: '0.0.0',
    transports: {stdio: false},
    ...cfg,
  });
  for (const c of opts.classes ?? [DocEvents]) app.service(c as never);
  const delivery =
    opts.delivery === undefined ? new FakeDelivery() : opts.delivery;
  if (delivery) app.bind(MCPBindings.EVENT_DELIVERY).to(delivery);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server, delivery: delivery as FakeDelivery};
}

async function connect(server: MCPServer, scopes?: string[]) {
  return (await connectWithSpy(server, scopes)).client;
}

/** Connect a client, recording every server→client message as sent. */
async function connectWithSpy(server: MCPServer, scopes?: string[]) {
  const sdk = server.buildServer({scopes});
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const sent: unknown[] = [];
  const origSend = st.send.bind(st);
  st.send = async (msg, opts) => {
    sent.push(msg);
    return origSend(msg, opts);
  };
  await sdk.connect(st);
  const client = new Client({name: 'c', version: '0.0.0'});
  await client.connect(ct);
  return {client, sent};
}

/** The capabilities the server put on the wire in its initialize result. */
function wireCapabilities(sent: unknown[]): Record<string, unknown> {
  const init = sent.find(
    m =>
      (m as {result?: {capabilities?: unknown}}).result?.capabilities !==
      undefined,
  ) as {result: {capabilities: Record<string, unknown>}};
  return init.result.capabilities;
}

const anyResult = z.any();

function authInfo(id: string, scopes: string[] = []): AuthInfo {
  return {
    token: 't',
    clientId: id,
    scopes,
    extra: {user: {[securityId]: id, scopes} as UserProfile},
  };
}

/** Call the protected handler body as an authenticated HTTP request would. */
function subscribe(
  server: MCPServer,
  params: unknown,
  opts: {auth?: AuthInfo; scopes?: string[]} = {},
) {
  return (
    server as unknown as {
      subscribeEvent(p: unknown, e: unknown, s?: string[]): Promise<unknown>;
    }
  ).subscribeEvent(params, fakeExtra(opts.auth), opts.scopes) as Promise<{
    id: string;
    refreshBefore: string | null;
    cursor: null;
    truncated: false;
  }>;
}

function unsubscribe(server: MCPServer, params: unknown, auth?: AuthInfo) {
  return (
    server as unknown as {
      unsubscribeEvent(p: unknown, e: unknown): Promise<unknown>;
    }
  ).unsubscribeEvent(params, fakeExtra(auth));
}

function fakeExtra(auth?: AuthInfo) {
  return {
    mcpReq: {signal: new AbortController().signal},
    ...(auth ? {http: {authInfo: auth}} : {}),
  };
}

function subParams(over: Record<string, unknown> = {}) {
  return {
    name: 'comment.created',
    arguments: {document_id: 'd1'},
    delivery: {mode: 'webhook', url: URL1, secret: SECRET},
    ...over,
  };
}

describe('@event', () => {
  it('records metadata and refuses @inject at slots 0 and 1', () => {
    expect(() => {
      class Bad {
        @event('x', {payload: z.object({})})
        m(@inject('a') _a: unknown) {
          return true;
        }
      }
      return Bad;
    }).toThrow(/slots 0 and 1 are reserved/);
  });

  it('requires a payload schema', () => {
    expect(() => {
      class Bad {
        @event('x', {} as never)
        m() {
          return true;
        }
      }
      return Bad;
    }).toThrow(/payload: is required/);
  });

  it('rejects a non-object payload when a server is built', async () => {
    @mcpServer()
    class Scalar {
      @event('scalar', {payload: z.string() as never})
      m() {
        return true;
      }
    }
    const {server} = await givenServer({}, {classes: [Scalar]});
    expect(() => server.buildServer()).toThrow(
      /payload schema must be an object/,
    );
  });

  it('refuses duplicate event names at start()', async () => {
    @mcpServer()
    class Dup {
      @event('comment.created', {payload: Created})
      other() {
        return true;
      }
    }
    const {server} = await givenServer({}, {classes: [DocEvents, Dup]});
    await expect(server.start()).rejects.toThrow(
      /Duplicate MCP event name 'comment.created'/,
    );
  });
});

describe('events/list and the events capability', () => {
  it('lists events with JSON Schemas and webhook delivery', async () => {
    const {server} = await givenServer();
    const client = await connect(server);
    const res = await client.request(
      {method: 'events/list', params: {}},
      anyResult,
    );
    const created = res.events.find(
      (e: {name: string}) => e.name === 'comment.created',
    );
    expect(created).toMatchObject({
      name: 'comment.created',
      description: 'A new review comment was added to the document.',
      delivery: ['webhook'],
      inputSchema: {
        type: 'object',
        properties: {document_id: {type: 'string'}},
      },
      payloadSchema: {type: 'object'},
    });
    // An event with no input publishes an empty object schema.
    expect(
      res.events.find((e: {name: string}) => e.name === 'doc.touched')
        .inputSchema,
    ).toEqual({type: 'object'});
    await client.close();
  });

  it('advertises a top-level events capability (pins the SDK pass-through)', async () => {
    // Asserted on the bytes the server SENDS: the SDK's capability schema is
    // strict, so a client parses `events` away — and a server SDK that began
    // parsing its own capabilities would strip it with no error anywhere,
    // and ChatGPT would silently stop seeing events. This catches that.
    const {server} = await givenServer();
    const {client, sent} = await connectWithSpy(server);
    expect(wireCapabilities(sent).events).toEqual({});
    await client.close();
  });

  it('does not advertise events when the app declares none', async () => {
    @mcpServer()
    class ToolsOnly {
      @tool('t')
      t() {
        return 1;
      }
    }
    const {server} = await givenServer({}, {classes: [ToolsOnly]});
    const {client, sent} = await connectWithSpy(server);
    expect(wireCapabilities(sent).events).toBeUndefined();
    await client.close();
  });

  it('hides a scoped event from an anonymous caller ([] scopes)', async () => {
    const {server} = await givenServer();
    const anon = await connect(server, []);
    const names = (
      await anon.request({method: 'events/list', params: {}}, anyResult)
    ).events.map((e: {name: string}) => e.name);
    expect(names).toContain('comment.created');
    expect(names).not.toContain('doc.archived');

    const admin = await connect(server, ['docs:admin']);
    const adminNames = (
      await admin.request({method: 'events/list', params: {}}, anyResult)
    ).events.map((e: {name: string}) => e.name);
    expect(adminNames).toContain('doc.archived');
    await anon.close();
    await admin.close();
  });
});

describe('events/subscribe', () => {
  it('answers -32012 to an anonymous caller over the wire', async () => {
    const {server} = await givenServer();
    const client = await connect(server);
    await expect(
      client.request(
        {method: 'events/subscribe', params: subParams()},
        anyResult,
      ),
    ).rejects.toMatchObject({code: McpEventErrorCodes.Forbidden});
    await client.close();
  });

  it('subscribes a localPrincipal over the wire', async () => {
    const {server, delivery} = await givenServer({
      localPrincipal: {[securityId]: 'local'} as UserProfile,
    });
    const client = await connect(server);
    const res = await client.request(
      {method: 'events/subscribe', params: subParams()},
      anyResult,
    );
    expect(res).toMatchObject({cursor: null, truncated: false});
    expect(res.id).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(delivery.verified).toHaveLength(1);
    await client.close();
  });

  it('grants a default TTL and returns a deterministic id', async () => {
    const {server, delivery} = await givenServer();
    const before = Date.now();
    const res = await subscribe(server, subParams(), {auth: authInfo('u1')});
    const expires = Date.parse(res.refreshBefore!);
    expect(expires).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(res.id).toBe(
      await subscriptionId('u1', URL1, 'comment.created', {document_id: 'd1'}),
    );
    expect(delivery.verified).toEqual([
      {subscriptionId: res.id, principal: 'u1', url: URL1, secret: SECRET},
    ]);
  });

  it('is idempotent: a refresh keeps the id and skips re-verification', async () => {
    const {server, delivery} = await givenServer();
    const auth = authInfo('u1');
    const a = await subscribe(server, subParams(), {auth});
    const b = await subscribe(server, subParams(), {auth});
    expect(b.id).toBe(a.id);
    // Different arguments, same (principal, url): still verified.
    await subscribe(server, subParams({arguments: {document_id: 'd2'}}), {
      auth,
    });
    expect(delivery.verified).toHaveLength(1);
    // Another principal at the same URL is verified separately.
    await subscribe(server, subParams(), {auth: authInfo('u2')});
    expect(delivery.verified).toHaveLength(2);
  });

  it('keys arguments by canonical JSON', async () => {
    const id1 = await subscriptionId('p', URL1, 'e', {a: 1, b: 2});
    const id2 = await subscriptionId('p', URL1, 'e', {b: 2, a: 1});
    expect(id1).toBe(id2);
    expect(await subscriptionId('q', URL1, 'e', {a: 1, b: 2})).not.toBe(id1);
  });

  it.each([
    ['an http url', {delivery: {url: 'http://h.example.com', secret: SECRET}}],
    [
      'a url with credentials',
      {delivery: {url: 'https://u:p@h.example.com', secret: SECRET}},
    ],
    ['a missing secret', {delivery: {url: URL1}}],
    ['a non-whsec secret', {delivery: {url: URL1, secret: 'shh'}}],
    [
      'a short secret',
      {delivery: {url: URL1, secret: `whsec_${btoa('x'.repeat(16))}`}},
    ],
    [
      'a long secret',
      {delivery: {url: URL1, secret: `whsec_${btoa('x'.repeat(65))}`}},
    ],
    ['invalid arguments', {arguments: {document_id: 7}}],
    ['a negative ttlMs', {ttlMs: -1}],
    ['a fractional ttlMs', {ttlMs: 1.5}],
  ])('rejects %s with -32602', async (_l, over) => {
    const {server} = await givenServer();
    await expect(
      subscribe(server, subParams(over), {auth: authInfo('u1')}),
    ).rejects.toMatchObject({code: -32602});
  });

  it('rejects arguments for an event that takes none', async () => {
    const {server} = await givenServer();
    await expect(
      subscribe(server, subParams({name: 'doc.touched', arguments: {x: 1}}), {
        auth: authInfo('u1'),
      }),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringMatching(/takes no arguments/),
    });
  });

  it('answers an unknown or scope-hidden event with -32011 {kind: event}', async () => {
    const {server} = await givenServer();
    const auth = authInfo('u1');
    await expect(
      subscribe(server, subParams({name: 'nope'}), {auth}),
    ).rejects.toMatchObject({
      code: McpEventErrorCodes.NotFound,
      data: {kind: 'event'},
    });
    await expect(
      subscribe(server, subParams({name: 'doc.archived', arguments: {}}), {
        auth,
        scopes: [],
      }),
    ).rejects.toMatchObject({code: McpEventErrorCodes.NotFound});
  });

  it('answers -32012 when the event method’s voters deny', async () => {
    const {server} = await givenServer({}, {classes: [GatedEvents]});
    await expect(
      subscribe(server, subParams({name: 'audit.logged', arguments: {}}), {
        auth: authInfo('u1'),
      }),
    ).rejects.toMatchObject({code: McpEventErrorCodes.Forbidden});
  });

  it('answers -32014 for another delivery mode or no delivery port', async () => {
    const {server} = await givenServer();
    await expect(
      subscribe(
        server,
        subParams({delivery: {mode: 'push', url: URL1, secret: SECRET}}),
        {auth: authInfo('u1')},
      ),
    ).rejects.toMatchObject({
      code: McpEventErrorCodes.Unsupported,
      data: {feature: 'deliveryMode', value: 'push'},
    });
    const {server: bare} = await givenServer({}, {delivery: false});
    await expect(
      subscribe(bare, subParams(), {auth: authInfo('u1')}),
    ).rejects.toMatchObject({
      code: McpEventErrorCodes.Unsupported,
      data: {feature: 'deliveryMode', value: 'webhook'},
    });
  });

  it('answers -32015 with the reason when verification fails, and stores nothing', async () => {
    const {app: a, server, delivery} = await givenServer();
    delivery.failWith = new CallbackEndpointError('challenge_failed');
    await expect(
      subscribe(server, subParams(), {auth: authInfo('u1')}),
    ).rejects.toMatchObject({
      code: McpEventErrorCodes.CallbackEndpointError,
      data: {reason: 'challenge_failed'},
    });
    const store = await a.get(MCPBindings.SUBSCRIPTION_STORE);
    expect(await store.listByEvent('comment.created')).toEqual([]);
    expect(await store.isVerified('u1', URL1)).toBe(false);
  });

  it('caps live subscriptions per principal with -32013', async () => {
    const {server} = await givenServer({
      events: {maxSubscriptionsPerPrincipal: 1},
    });
    const auth = authInfo('u1');
    await subscribe(server, subParams(), {auth});
    // A refresh of the same subscription is not a new one.
    await subscribe(server, subParams(), {auth});
    await expect(
      subscribe(server, subParams({arguments: {document_id: 'd2'}}), {auth}),
    ).rejects.toMatchObject({
      code: McpEventErrorCodes.ResourceExhausted,
      data: {limit: 'subscriptions', max: 1},
    });
  });

  it('keeps the replaced secret for the rotation grace window', async () => {
    const {app: a, server} = await givenServer();
    const auth = authInfo('u1');
    const {id} = await subscribe(server, subParams(), {auth});
    await subscribe(
      server,
      subParams({delivery: {url: URL1, secret: SECRET2}}),
      {auth},
    );
    const sub = await (await a.get(MCPBindings.SUBSCRIPTION_STORE)).get(id);
    expect(sub?.secret).toBe(SECRET2);
    expect(sub?.previousSecret?.secret).toBe(SECRET);
    expect(sub?.previousSecret?.until).toBeGreaterThan(Date.now());
  });

  it('survives across per-request servers (app-level store)', async () => {
    const {app: a, server} = await givenServer({
      localPrincipal: {[securityId]: 'local'} as UserProfile,
    });
    // Request 1 subscribes on one stateless server…
    const c1 = await connect(server);
    await c1.request(
      {method: 'events/subscribe', params: subParams()},
      anyResult,
    );
    await c1.close();
    // …the emit that delivers runs after that server is gone.
    const emitter = await a.get(MCPBindings.EVENTS);
    const report = await emitter.emit('comment.created', {
      document_id: 'd1',
      comment_id: 'c1',
      text: 'hi',
    });
    expect(report).toMatchObject({subscriptions: 1, delivered: 1});
    // Request 2, on a fresh server, unsubscribes the same subscription.
    const c2 = await connect(server);
    await c2.request(
      {
        method: 'events/unsubscribe',
        params: {
          name: 'comment.created',
          arguments: {document_id: 'd1'},
          delivery: {url: URL1},
        },
      },
      anyResult,
    );
    await c2.close();
    expect(
      (
        await emitter.emit('comment.created', {
          document_id: 'd1',
          comment_id: 'c2',
          text: 'again',
        })
      ).subscriptions,
    ).toBe(0);
  });
});

describe('events/unsubscribe', () => {
  const unsub = {
    name: 'comment.created',
    arguments: {document_id: 'd1'},
    delivery: {url: URL1},
  };

  it('removes the subscription, then answers -32011 {kind: subscription}', async () => {
    const {server} = await givenServer();
    const auth = authInfo('u1');
    await subscribe(server, subParams(), {auth});
    await expect(unsubscribe(server, unsub, auth)).resolves.toEqual({});
    await expect(unsubscribe(server, unsub, auth)).rejects.toMatchObject({
      code: McpEventErrorCodes.NotFound,
      data: {kind: 'subscription'},
    });
  });

  it('cannot remove another principal’s subscription', async () => {
    const {server} = await givenServer();
    await subscribe(server, subParams(), {auth: authInfo('u1')});
    await expect(
      unsubscribe(server, unsub, authInfo('u2')),
    ).rejects.toMatchObject({code: McpEventErrorCodes.NotFound});
  });

  it('requires a principal', async () => {
    const {server} = await givenServer();
    await expect(unsubscribe(server, unsub)).rejects.toMatchObject({
      code: McpEventErrorCodes.Forbidden,
    });
  });
});

describe('emit', () => {
  async function subscribed(
    over: Record<string, unknown> = {},
    auth = authInfo('u1'),
    cfg: Partial<MCPServerConfig> = {},
    classes?: Function[],
  ) {
    const ctx = await givenServer(cfg, {classes});
    await subscribe(ctx.server, subParams(over), {auth});
    const emitter = await ctx.app.get(MCPBindings.EVENTS);
    return {...ctx, emitter};
  }

  it('delivers to matching subscriptions only', async () => {
    const {server, delivery, emitter} = await subscribed();
    await subscribe(server, subParams({arguments: {document_id: 'd2'}}), {
      auth: authInfo('u1'),
    });
    const report = await emitter.emit(
      'comment.created',
      {document_id: 'd2', comment_id: 'c9', text: 'x', extra: 'stripped'},
      {eventId: 'gh-123', timestamp: '2026-10-01T00:00:00Z'},
    );
    expect(report).toEqual({
      eventId: 'gh-123',
      subscriptions: 2,
      delivered: 1,
      revoked: 0,
    });
    expect(delivery.delivered).toHaveLength(1);
    expect(delivery.delivered[0]!.sub.arguments).toEqual({document_id: 'd2'});
    expect(delivery.delivered[0]!.occurrence).toEqual({
      eventId: 'gh-123',
      name: 'comment.created',
      timestamp: '2026-10-01T00:00:00.000Z',
      // The validated payload: unknown keys are stripped by the schema.
      data: {document_id: 'd2', comment_id: 'c9', text: 'x'},
      cursor: null,
    });
  });

  it('validates the payload at emit time and delivers nothing on mismatch', async () => {
    const {delivery, emitter} = await subscribed();
    await expect(
      emitter.emit('comment.created', {document_id: 'd1'}),
    ).rejects.toThrow(/Invalid payload for event comment.created: comment_id/);
    expect(delivery.delivered).toHaveLength(0);
  });

  it('throws for an unknown event and mints evt_ ids by default', async () => {
    const {emitter} = await subscribed();
    await expect(emitter.emit('nope', {})).rejects.toThrow(/Unknown MCP event/);
    const r = await emitter.emit('comment.created', {
      document_id: 'zz',
      comment_id: 'c',
      text: 't',
    });
    expect(r.eventId).toMatch(/^evt_[0-9a-f-]{36}$/);
  });

  it('binds the subscriber as SecurityBindings.USER while match runs', async () => {
    const {server, delivery, emitter} = await subscribed({
      name: 'doc.touched',
      arguments: {},
    });
    await subscribe(server, subParams({name: 'doc.touched', arguments: {}}), {
      auth: authInfo('blocked'),
    });
    const r = await emitter.emit('doc.touched', {by: 'x'});
    expect(r).toMatchObject({subscriptions: 2, delivered: 1});
    expect(delivery.delivered[0]!.sub.principal).toBe('u1');
  });

  it('treats a non-boolean match result as no match', async () => {
    const {delivery, emitter} = await subscribed({
      name: 'doc.sloppy',
      arguments: {},
    });
    expect((await emitter.emit('doc.sloppy', {n: 1})).delivered).toBe(0);
    expect(delivery.delivered).toHaveLength(0);
  });

  it('isolates a throwing match from the other subscriptions', async () => {
    const {server, emitter} = await subscribed({
      name: 'doc.throws',
      arguments: {},
    });
    await subscribe(server, subParams({name: 'doc.throws', arguments: {}}), {
      auth: authInfo('u2'),
    });
    expect((await emitter.emit('doc.throws', {n: 1})).delivered).toBe(0);
    expect((await emitter.emit('doc.throws', {n: 2})).delivered).toBe(2);
  });

  it('revokes a subscription the access check refuses', async () => {
    const {app: a, delivery, emitter} = await subscribed();
    const allowed = new Set(['u1']);
    a.bind(MCPBindings.EVENT_ACCESS_CHECK).to((sub: EventSubscription) =>
      allowed.has(sub.principal),
    );
    const data = {document_id: 'd1', comment_id: 'c', text: 't'};
    expect((await emitter.emit('comment.created', data)).delivered).toBe(1);
    allowed.delete('u1');
    expect(await emitter.emit('comment.created', data)).toMatchObject({
      delivered: 0,
      revoked: 1,
    });
    // Deleted, not merely skipped.
    expect((await emitter.emit('comment.created', data)).subscriptions).toBe(0);
    expect(delivery.delivered).toHaveLength(1);
  });

  it('revokes when the event method’s voters now deny', async () => {
    const {app: a, delivery} = await givenServer({}, {classes: [GatedEvents]});
    const store = await a.get(MCPBindings.SUBSCRIPTION_STORE);
    // Subscribed while an auditor; the stored profile no longer is one.
    await store.put({
      id: 'sub_x',
      principal: 'u1',
      user: {[securityId]: 'u1', roles: []} as unknown as UserProfile,
      name: 'audit.logged',
      arguments: {},
      url: URL1,
      secret: SECRET,
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
      refreshedAt: Date.now(),
    });
    const emitter = await a.get(MCPBindings.EVENTS);
    expect(await emitter.emit('audit.logged', {line: 'l'})).toMatchObject({
      delivered: 0,
      revoked: 1,
    });
    expect(delivery.delivered).toHaveLength(0);
  });

  it('never delivers to an expired subscription', async () => {
    const {app: a, delivery} = await givenServer();
    const store = await a.get(MCPBindings.SUBSCRIPTION_STORE);
    await store.put({
      id: 'sub_old',
      principal: 'u1',
      user: {[securityId]: 'u1'} as UserProfile,
      name: 'comment.created',
      arguments: {document_id: 'd1'},
      url: URL1,
      secret: SECRET,
      expiresAt: Date.now() - 1,
      createdAt: 0,
      refreshedAt: 0,
    });
    const emitter = await a.get(MCPBindings.EVENTS);
    const r = await emitter.emit('comment.created', {
      document_id: 'd1',
      comment_id: 'c',
      text: 't',
    });
    expect(r.subscriptions).toBe(0);
    expect(delivery.delivered).toHaveLength(0);
  });
});

describe('subscription helpers', () => {
  const cfg = resolveEventsConfig({});

  it.each([
    [undefined, 60 * 60_000],
    [1_000, 60_000], // clamped up to the floor
    [10 * 60_000, 10 * 60_000],
    [365 * 24 * 60 * 60_000, 24 * 60 * 60_000], // clamped down to the ceiling
    [null, 60 * 60_000], // no expiry not granted by default
  ])('grantTtl(%j) grants %d ms', (requested, ttl) => {
    const g = grantTtl(requested as number | null | undefined, cfg, 1_000);
    expect(g.expiresAt).toBe(1_000 + ttl);
    expect(g.refreshBefore).toBe(new Date(1_000 + ttl).toISOString());
  });

  it('grants no expiry only when configured and asked for', () => {
    const open = resolveEventsConfig({allowNoExpiry: true});
    expect(grantTtl(null, open, 0)).toEqual({
      expiresAt: null,
      refreshBefore: null,
    });
    expect(grantTtl(undefined, open, 0).refreshBefore).not.toBeNull();
  });

  it('validates the config at boot', () => {
    expect(() => resolveEventsConfig({minTtlMs: 10, maxTtlMs: 5})).toThrow(
      /minTtlMs exceeds maxTtlMs/,
    );
    expect(() => resolveEventsConfig({defaultTtlMs: -1})).toThrow(
      /defaultTtlMs must be a number >= 0/,
    );
  });

  it.each([
    [SECRET, true],
    [`whsec_${btoa('x'.repeat(24))}`, true],
    [`whsec_${btoa('x'.repeat(64))}`, true],
    [`whsec_${btoa('x'.repeat(23))}`, false],
    [`whsec_${btoa('x'.repeat(65))}`, false],
    ['whsec_not base64!', false],
    [btoa('x'.repeat(32)), false],
  ])('isWebhookSecret(%s) is %s', (secret, ok) => {
    expect(isWebhookSecret(secret)).toBe(ok);
  });

  it('InMemorySubscriptionStore expires subscriptions and verifications', async () => {
    let now = 0;
    const store = new InMemorySubscriptionStore(() => now);
    await store.put({
      id: 's',
      principal: 'p',
      user: {[securityId]: 'p'} as UserProfile,
      name: 'e',
      arguments: {},
      url: URL1,
      secret: SECRET,
      expiresAt: 100,
      createdAt: 0,
      refreshedAt: 0,
    });
    await store.markVerified('p', URL1, 50);
    expect(await store.countByPrincipal('p')).toBe(1);
    expect(await store.isVerified('p', URL1)).toBe(true);
    now = 60;
    expect(await store.isVerified('p', URL1)).toBe(false);
    now = 100;
    expect(await store.get('s')).toBeUndefined();
    expect(await store.listByEvent('e')).toEqual([]);
    expect(await store.delete('s')).toBe(false);
  });
});
