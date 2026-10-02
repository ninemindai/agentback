// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {inject, Context} from '@agentback/context';
import {Application} from '@agentback/core';
import {mcpServer, tool} from '../../decorators/index.js';
import {
  createElicitSession,
  isInputRequired,
  type Elicitor,
} from '../../elicit.js';
import {
  MCP_DISPATCH_HOOK_TAG,
  MCPBindings,
  type McpDispatchHook,
} from '../../keys.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer, type ToolBinding} from '../../mcp.server.js';
import {selectTools} from '../../select-tools.js';

// P1-7 phase 2: user-authored elicitation (docs/proposals/host-extensions.md §5).

const Part = z.object({part: z.enum(['bolt', 'nut'])});
const Qty = z.object({qty: z.number().int().min(1)});

/** Counts how many times each tool body ran (every round re-runs it). */
const runs: Record<string, number> = {};
const bump = (k: string) => (runs[k] = (runs[k] ?? 0) + 1);

@mcpServer()
class Shop {
  // Costly work that must precede the question: runs once per call.
  @tool('quote')
  async quote(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    bump('quote');
    const price = await elicit.once('price', async () => {
      bump('price');
      return {cents: 42};
    });
    const {part} = await elicit.ask('part', {
      message: 'Which part?',
      standard: Part,
    });
    return `${part} at ${price.cents}`;
  }

  @tool('price_only')
  async priceOnly(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    return elicit.once('price', () => ({cents: 7}));
  }

  @tool('pick')
  async pick(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    bump('pick');
    const {part} = await elicit.ask('part', {
      message: 'Which part?',
      standard: Part,
    });
    return `picked ${part}`;
  }

  @tool('order')
  async order(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    bump('order');
    const {part} = await elicit.ask('part', {
      message: 'Which part?',
      standard: Part,
    });
    const {qty} = await elicit.ask('qty', {
      message: 'How many?',
      standard: Qty,
    });
    return `ordered ${qty} x ${part}`;
  }

  @tool('both')
  async both(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    bump('both');
    const a = await elicit.askAll({
      part: {message: 'Which part?', standard: Part},
      qty: {message: 'How many?', standard: Qty},
    });
    return `both ${a.qty.qty} x ${a.part.part}`;
  }

  @tool('deploy', {input: z.object({env: z.string()}), confirm: true})
  async deploy(
    input: {env: string},
    @inject(MCPBindings.ELICIT) elicit: Elicitor,
  ) {
    bump('deploy');
    const {part} = await elicit.ask('part', {
      message: 'Which part?',
      standard: Part,
    });
    return `deployed ${part} to ${input.env}`;
  }

  @tool('fancy')
  async fancy(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    const {part} = await elicit.ask('part', {
      message: 'Which part?',
      standard: Part,
      extended: {
        type: 'object',
        properties: {part: {type: 'string', enum: ['bolt', 'nut']}},
        required: ['part'],
        'x-openai-widget': 'part-picker',
      },
    });
    return `fancy ${part}`;
  }

  @tool('plain')
  plain() {
    return 'plain';
  }
}

/** Misbehaving tools for the guards. */
@mcpServer()
class Bad {
  @tool('swallow')
  async swallow(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    try {
      await elicit.ask('part', {message: 'Which?', standard: Part});
    } catch {
      return 'swallowed';
    }
  }

  @tool('rethrow_other')
  async rethrowOther(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    try {
      await elicit.ask('part', {message: 'Which?', standard: Part});
    } catch (e) {
      if (isInputRequired(e)) throw new Error('wrapped');
      throw e;
    }
  }

  @tool('reserved')
  async reserved(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    await elicit.ask('confirm', {message: 'x', standard: Part});
  }

  @tool('nested')
  async nested(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    await elicit.ask('n', {
      message: 'x',
      standard: z.object({inner: z.object({a: z.string()})}),
    });
  }

  @tool('stream_then_ask')
  async *streamThenAsk(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    yield 1;
    await elicit.ask('part', {message: 'late', standard: Part});
    yield 2;
  }
}

type Answer =
  | {action: 'accept'; content: Record<string, string | number>}
  | {action: 'decline' | 'cancel'};

const apps: Application[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop();
  for (const k of Object.keys(runs)) delete runs[k];
});

async function boot(opts: {hooks?: McpDispatchHook[]} = {}) {
  const app = new Application();
  apps.push(app);
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'elicit',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(Shop);
  app.service(Bad);
  (opts.hooks ?? []).forEach((h, i) =>
    app.bind(`hooks.h${i}`).to(h).tag(MCP_DISPATCH_HOOK_TAG),
  );
  const server = await app.get<MCPServer>('servers.MCPServer');
  await server.start();
  return server;
}

/**
 * A real SDK client over an in-memory pair, on either era. With `answer`, it
 * declares `elicitation` and answers each request by its message.
 */
async function connect(
  server: MCPServer,
  era: 'modern' | 'legacy',
  answer?: (message: string, schema: Record<string, unknown>) => Answer,
  extraCaps: Record<string, unknown> = {},
) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  server.serveTransport(st);
  const client = new Client(
    {name: 'c', version: '0.0.0'},
    {
      ...(era === 'modern'
        ? {versionNegotiation: {mode: 'auto' as const}}
        : {}),
      capabilities: {...(answer ? {elicitation: {}} : {}), ...extraCaps},
    },
  );
  const seen: {message: string; schema: Record<string, unknown>}[] = [];
  if (answer) {
    client.setRequestHandler('elicitation/create', async req => {
      const p = req.params as {
        message: string;
        requestedSchema: Record<string, unknown>;
      };
      seen.push({message: p.message, schema: p.requestedSchema});
      return answer(p.message, p.requestedSchema) as never;
    });
  }
  await client.connect(ct);
  expect(client.getProtocolEra()).toBe(era);
  return {client, seen};
}

const text = (r: {content?: unknown}) =>
  (r.content as {text: string}[])[0]?.text;
const errorCode = (r: {content?: unknown; isError?: boolean}) => {
  expect(r.isError).toBe(true);
  return (JSON.parse(text(r)) as {error: {code: string}}).error.code;
};

const byMessage = (m: string): Answer =>
  m === 'Which part?'
    ? {action: 'accept', content: {part: 'bolt'}}
    : m === 'How many?'
      ? {action: 'accept', content: {qty: 3}}
      : {action: 'accept', content: {confirm: true} as never};

describe.each(['modern', 'legacy'] as const)('elicit on the %s era', era => {
  it('once: runs costly work once per call, not once per round', async () => {
    const server = await boot();
    const {client} = await connect(server, era, byMessage);
    runs.quote = 0;
    runs.price = 0;
    const r = await client.callTool({name: 'quote', arguments: {}});
    expect(text(r)).toBe('bolt at 42');
    expect(runs.quote).toBe(2); // the body re-ran…
    expect(runs.price).toBe(1); // …but the costly work did not
  });

  it('asks, re-runs the tool from the top, and returns the answer', async () => {
    const server = await boot();
    const {client, seen} = await connect(server, era, byMessage);
    const r = await client.callTool({name: 'pick', arguments: {}});
    expect(text(r)).toBe('picked bolt');
    expect(seen.map(s => s.message)).toEqual(['Which part?']);
    expect(runs.pick).toBe(2);
    // The standard form lowers to a flat object the client can render.
    expect(seen[0]!.schema).toMatchObject({
      type: 'object',
      properties: {part: {type: 'string', enum: ['bolt', 'nut']}},
    });
  });

  it('accumulates answers across rounds instead of re-asking', async () => {
    const server = await boot();
    const {client, seen} = await connect(server, era, byMessage);
    const r = await client.callTool({name: 'order', arguments: {}});
    expect(text(r)).toBe('ordered 3 x bolt');
    // 'Which part?' is asked once: round 3 replays it from request state.
    expect(seen.map(s => s.message)).toEqual(['Which part?', 'How many?']);
    expect(runs.order).toBe(3);
  });

  it('askAll asks every missing question in one round', async () => {
    const server = await boot();
    const {client, seen} = await connect(server, era, byMessage);
    const r = await client.callTool({name: 'both', arguments: {}});
    expect(text(r)).toBe('both 3 x bolt');
    expect(seen.map(s => s.message).sort()).toEqual([
      'How many?',
      'Which part?',
    ]);
    expect(runs.both).toBe(2);
  });

  it('a declined question fails the call with elicitation_declined', async () => {
    const server = await boot();
    const {client} = await connect(server, era, () => ({action: 'decline'}));
    const r = await client.callTool({name: 'pick', arguments: {}});
    expect(errorCode(r)).toBe('elicitation_declined');
  });

  it('an answer that fails the form schema is invalid_input', async () => {
    const server = await boot();
    const {client} = await connect(server, era, () => ({
      action: 'accept',
      content: {part: 'washer'},
    }));
    const r = await client.callTool({name: 'pick', arguments: {}});
    expect(errorCode(r)).toBe('invalid_input');
  });

  it('a client that cannot elicit gets elicitation_unavailable', async () => {
    const server = await boot();
    const {client} = await connect(server, era);
    const r = await client.callTool({name: 'pick', arguments: {}});
    expect(errorCode(r)).toBe('elicitation_unavailable');
  });

  it('sends the extended form only to 2026 clients declaring openai/elicitation', async () => {
    const server = await boot();
    const ext = {'openai/elicitation': {}};
    const plain = await connect(server, era, byMessage);
    const fancy = await connect(
      server,
      era,
      byMessage,
      era === 'modern' ? {extensions: ext} : {experimental: ext},
    );
    expect(
      text(await plain.client.callTool({name: 'fancy', arguments: {}})),
    ).toBe('fancy bolt');
    expect(
      text(await fancy.client.callTool({name: 'fancy', arguments: {}})),
    ).toBe('fancy bolt');
    expect(plain.seen[0]!.schema).not.toHaveProperty('x-openai-widget');
    if (era === 'modern') {
      // Q1: a top-level vendor key survives to a TS SDK client (property-level
      // vendor keys are stripped by the client's schema; see the guide).
      expect(fancy.seen[0]!.schema).toHaveProperty(
        'x-openai-widget',
        'part-picker',
      );
    } else {
      // A 2025 connection would need `openai/elicitation/create`; the shim
      // sends `elicitation/create`, so the standard form goes instead.
      expect(fancy.seen[0]!.schema).not.toHaveProperty('x-openai-widget');
    }
  });
});

describe('elicit — confirm: composes with ask', () => {
  it('modern: confirm prompt, then the question, then the result', async () => {
    const server = await boot();
    const {client, seen} = await connect(server, 'modern', byMessage);
    const r = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod'},
    });
    expect(text(r)).toBe('deployed bolt to prod');
    expect(seen.map(s => s.message)).toEqual([
      'Confirm running deploy.',
      'Which part?',
    ]);
  });

  it('legacy: the token dance, then the question over the SDK shim', async () => {
    const server = await boot();
    const {client, seen} = await connect(server, 'legacy', byMessage);
    const first = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod'},
    });
    expect(errorCode(first)).toBe('confirmation_required');
    const token = (
      JSON.parse(text(first)) as {error: {confirmationToken: string}}
    ).error.confirmationToken;
    const r = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod', confirmationToken: token},
    });
    // The shim re-enters with the same (spent) input token; the envelope's
    // fresh `confirmed` token is what lets round 2 through.
    expect(text(r)).toBe('deployed bolt to prod');
    expect(seen.map(s => s.message)).toEqual(['Which part?']);
  });
});

describe('elicit — guards', () => {
  it.each([
    [
      'swallow',
      "@tool('swallow') on Bad.swallow: elicit.ask('part') suspended the call but the tool swallowed the signal",
    ],
    [
      'rethrow_other',
      "@tool('rethrow_other') on Bad.rethrowOther: elicit.ask('part') suspended",
    ],
    ['reserved', "elicit.ask('confirm'): the 'confirm' key is reserved"],
    ['nested', "elicit.ask('n'): field 'inner' is not a primitive"],
    ['stream_then_ask', "elicit.ask('part') after the tool streamed 1 item(s)"],
  ])('%s fails loudly', async (name, message) => {
    const server = await boot();
    // In-process: the guard fires before the caller's own limits apply.
    await expect(server.callTool(name, {})).rejects.toThrow(message);
  });

  it('once: guards its key, its value and its size', async () => {
    const session = createElicitSession({}, undefined);
    await expect(session.once('k', () => 1)).resolves.toBe(1);
    await expect(session.once('k', () => 2)).rejects.toThrow(
      "elicit.once('k'): used twice in one call",
    );
    await expect(session.once('fn', () => () => 1)).rejects.toThrow(
      "elicit.once('fn'): the result is not JSON",
    );
    await expect(session.once('big', () => 1n)).rejects.toThrow(
      "elicit.once('big'): the result is not JSON",
    );
    await expect(
      session.once('huge', () => 'x'.repeat(40 * 1024)),
    ).rejects.toThrow(/over the 32768-byte limit/);
    expect(Object.keys(session.memo)).toEqual(['k']);
    // A replayed result is returned as a copy, without running fn.
    const replay = createElicitSession({}, undefined, {k: {a: 1}});
    let ran = false;
    const v = await replay.once('k', () => {
      ran = true;
      return {a: 2};
    });
    expect(v).toEqual({a: 1});
    expect(ran).toBe(false);
  });

  it('once: an in-process call simply runs fn', async () => {
    const server = await boot();
    await expect(server.callTool('price_only', {})).resolves.toEqual({
      cents: 7,
    });
  });

  it('a key asked twice in one call is a misuse', async () => {
    // The first ask must be answered for the second to run at all, so drive
    // the session directly with a replayed answer.
    const session = createElicitSession({part: {part: 'bolt'}}, undefined);
    const form = {message: 'Which?', standard: Part};
    await expect(session.ask('part', form)).resolves.toEqual({part: 'bolt'});
    await expect(session.ask('part', form)).rejects.toThrow(
      "elicit.ask('part'): asked twice in one call",
    );
  });

  it('an in-process callTool cannot answer: elicitation_unavailable', async () => {
    const server = await boot();
    await expect(server.callTool('pick', {})).rejects.toMatchObject({
      code: 'elicitation_unavailable',
    });
    // A simulated elicitation-capable client opens no round trip either.
    await expect(
      server.callTool(
        'pick',
        {},
        {
          simulate: {
            client: {
              era: 'modern',
              capabilities: {elicitation: {}},
              canRoundTrip: true,
            },
          },
        },
      ),
    ).rejects.toMatchObject({code: 'elicitation_unavailable'});
  });

  it('refuses a forged request state on a non-confirm tool', async () => {
    const server = await boot();
    const pick = server.listTools().find(t => t.meta.name === 'pick')!;
    const ctx = new Context(server['context'] as Context, 'mcp.request');
    ctx.bind(MCPBindings.REQUEST_EXTRA).to({
      mcpReq: {requestState: () => 'v1.forged.sig'},
    } as never);
    const dispatch = (
      server as unknown as {
        dispatchTool(t: ToolBinding, i: unknown, c: Context): Promise<unknown>;
      }
    ).dispatchTool.bind(server);
    await expect(dispatch(pick, {}, ctx)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('elicit — request boundaries', () => {
  const dispatchOf = (server: MCPServer) =>
    (
      server as unknown as {
        dispatchTool(t: ToolBinding, i: unknown, c: Context): Promise<unknown>;
      }
    ).dispatchTool.bind(server);

  function requestCtx(server: MCPServer, mcpReq: Record<string, unknown>) {
    const ctx = new Context(server['context'] as Context, 'mcp.request');
    ctx.bind(MCPBindings.REQUEST_EXTRA).to({mcpReq} as never);
    return ctx;
  }

  it('refuses request state minted for another tool', async () => {
    const server = await boot();
    const {client} = await connect(server, 'modern', byMessage);
    // Capture a real envelope for `pick`, then replay it against `order`.
    let captured = '';
    const tools = server.listTools();
    const pick = tools.find(t => t.meta.name === 'pick')!;
    const order = tools.find(t => t.meta.name === 'order')!;
    const ctx = requestCtx(server, {});
    ctx.bind(MCPBindings.REQUEST_CLIENT).to({
      era: 'modern',
      capabilities: {elicitation: {}},
      canRoundTrip: true,
    });
    const first = (await dispatchOf(server)(pick, {}, ctx)) as {
      requestState: string;
    };
    captured = first.requestState;
    await expect(
      dispatchOf(server)(
        order,
        {},
        requestCtx(server, {requestState: () => captured}),
      ),
    ).rejects.toMatchObject({code: 'invalid_input'});
    await client.close();
  });

  it('a tool called in-process from inside a request ignores that request state', async () => {
    // An agent turn or nested callTool inside round 2 of another tool's
    // elicitation must not read the outer envelope as its own.
    const server = await boot();
    const outer = requestCtx(server, {
      requestState: () => 'v1.not-for-you.sig',
      inputResponses: {part: {action: 'accept', content: {part: 'nut'}}},
    });
    await expect(server.callTool('plain', {}, {ctx: outer})).resolves.toBe(
      'plain',
    );
    // Nor the outer request's answers: the inner ask is unanswerable.
    await expect(
      server.callTool('pick', {}, {ctx: outer}),
    ).rejects.toMatchObject({code: 'elicitation_unavailable'});
  });

  it('a declined answer in askAll is reported, not called a swallowed signal', async () => {
    const server = await boot();
    const both = server.listTools().find(t => t.meta.name === 'both')!;
    const ctx = requestCtx(server, {
      inputResponses: {qty: {action: 'decline'}},
    });
    ctx.bind(MCPBindings.REQUEST_CLIENT).to({
      era: 'modern',
      capabilities: {elicitation: {}},
      canRoundTrip: true,
    });
    await expect(dispatchOf(server)(both, {}, ctx)).rejects.toMatchObject({
      code: 'elicitation_declined',
    });
  });

  it('serveTransport honours protocol: legacy', async () => {
    const app = new Application();
    apps.push(app);
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'legacy-only',
      version: '0.0.0',
      protocol: 'legacy',
      transports: {stdio: false},
    });
    app.service(Shop);
    const server = await app.get<MCPServer>('servers.MCPServer');
    const [ct, st] = InMemoryTransport.createLinkedPair();
    server.serveTransport(st);
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      {versionNegotiation: {mode: 'auto' as const}},
    );
    await client.connect(ct);
    expect(client.getProtocolEra()).toBe('legacy');
    await client.close();
  });

  it('an in-process ask names the cause', async () => {
    const server = await boot();
    await expect(server.callTool('pick', {})).rejects.toThrow(
      /called in-process/,
    );
  });
});

describe('elicit — cross-cutting', () => {
  it('dispatch hooks see inputRequired on the asking round only', async () => {
    const seen: boolean[] = [];
    const hook: McpDispatchHook = async (info, next) => {
      const r = await next();
      seen.push(info.inputRequired === true);
      return r;
    };
    const server = await boot({hooks: [hook]});
    const {client} = await connect(server, 'modern', byMessage);
    await client.callTool({name: 'pick', arguments: {}});
    expect(seen).toEqual([true, false]);
  });

  it('projections exclude tools that ask the user', async () => {
    const server = await boot();
    const names = selectTools(server.servedTools()).map(t => t.meta.name);
    expect(names).toContain('plain');
    expect(names).not.toContain('pick');
    expect(() =>
      selectTools(server.servedTools(), {include: ['pick']}),
    ).toThrow(/asks the user mid-call/);
  });
});
