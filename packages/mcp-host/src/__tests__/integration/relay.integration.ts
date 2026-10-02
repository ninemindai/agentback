// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {inject} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {
  MCPBindings,
  MCPComponent,
  MCPServer,
  mcpServer,
  appResource,
  tool,
  type Elicitor,
} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {createMcpHost, type McpHost} from '../../index.js';

// The gateway relays what host extensions need from a direct connection: a
// request's vendor `_meta` (ChatGPT's `openai/resource.path`) and an
// upstream tool's question to the user (elicitation), over both a stateless
// 2026 upstream (multi-round-trip results) and a 2025 session upstream (a
// real `elicitation/create`).

let seenMeta: Readonly<Record<string, unknown>> | undefined;

@mcpServer()
class Upstream {
  @tool('meta')
  meta(
    @inject(MCPBindings.REQUEST_META, {optional: true})
    meta?: Readonly<Record<string, unknown>>,
  ) {
    seenMeta = meta;
    return {keys: Object.keys(meta ?? {}).sort()};
  }

  @tool('greet')
  async greet(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    const {name} = await elicit.ask('who', {
      message: 'Your name?',
      standard: z.object({name: z.string()}),
    });
    return `hello ${name}`;
  }

  // Resource methods take no method-level injection; the domain resolver
  // sees the request `_meta`, which is what this read checks.
  @appResource('ui://up/doc', {
    name: 'doc',
    domain: ({meta}) =>
      meta?.['openai/resource'] ? 'meta-seen.example' : undefined,
  })
  doc() {
    return '<html></html>';
  }
}

const apps: RestApplication[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map(c => c().catch(() => {})));
  await Promise.all(apps.splice(0).map(a => a.stop()));
  seenMeta = undefined;
});

async function httpUpstream(): Promise<string> {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'up',
    version: '0',
    transports: {stdio: false},
  });
  app.service(Upstream);
  await app.get<MCPServer>('servers.MCPServer');
  await installMcpHttp(app); // stateless, both eras (the default)
  await app.start();
  apps.push(app);
  return (await app.restServer).url + '/mcp';
}

/** A 2025-era session upstream over an in-memory pair. */
async function legacyUpstream() {
  const app = new RestApplication({});
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'legacy',
    version: '0',
    protocol: 'legacy',
    transports: {stdio: false},
  });
  app.service(Upstream);
  const mcp = await app.get<MCPServer>('servers.MCPServer');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const served = mcp.serveTransport(serverSide);
  closers.push(() => served.close());
  return clientSide;
}

async function downstream(
  host: McpHost,
  opts: {canElicit?: boolean} = {},
): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await host.connect(serverSide);
  const client = new Client(
    {name: 'downstream', version: '0'},
    opts.canElicit === false ? {} : {capabilities: {elicitation: {form: {}}}},
  );
  if (opts.canElicit !== false) {
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
      content: {name: 'Ada'},
    }));
  }
  await client.connect(clientSide);
  closers.push(
    () => client.close(),
    () => host.close(),
  );
  return client;
}

const text = (r: unknown) =>
  (r as {content: {type: string; text: string}[]}).content
    .map(c => c.text)
    .join('');

describe('mcp-host relays request _meta', () => {
  it('forwards vendor keys only, on tools/call and resources/read', async () => {
    const host = await createMcpHost({
      upstreams: [{name: 'up', transport: 'http', url: await httpUpstream()}],
    });
    const client = await downstream(host);
    const res = await client.callTool({
      name: 'up__meta',
      arguments: {},
      _meta: {
        'openai/resource': {path: '/tmp/part.stl'},
        'com.example/trace': 'abc',
        progressToken: 7,
      },
    });
    expect(res.structuredContent ?? JSON.parse(text(res))).toEqual({
      keys: ['com.example/trace', 'openai/resource'],
    });
    expect(seenMeta?.['openai/resource']).toEqual({path: '/tmp/part.stl'});

    const read = await client.readResource({
      uri: 'ui://up/doc',
      _meta: {'openai/resource': {representation: 'text'}},
    });
    expect(read.contents[0]._meta).toEqual({
      ui: {domain: 'meta-seen.example'},
    });
  });

  it('honours relayMeta: false and a key predicate', async () => {
    const url = await httpUpstream();
    for (const [relayMeta, keys] of [
      [false, []],
      [(k: string) => k.startsWith('openai/'), ['openai/resource']],
    ] as const) {
      const host = await createMcpHost({
        upstreams: [{name: 'up', transport: 'http', url}],
        relayMeta,
      });
      const client = await downstream(host);
      const res = await client.callTool({
        name: 'up__meta',
        arguments: {},
        _meta: {'openai/resource': {path: '/x'}, 'com.example/y': 1},
      });
      expect(res.structuredContent ?? JSON.parse(text(res))).toEqual({
        keys,
      });
    }
  });
});

describe('mcp-host relays elicitation', () => {
  it('through a stateless 2026 upstream (multi-round-trip results)', async () => {
    const host = await createMcpHost({
      upstreams: [{name: 'up', transport: 'http', url: await httpUpstream()}],
    });
    const client = await downstream(host);
    const res = await client.callTool({name: 'up__greet', arguments: {}});
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('hello Ada');
  });

  it('through a 2025 session upstream (elicitation/create)', async () => {
    const host = await createMcpHost({
      upstreams: [
        {
          name: 'legacy',
          transport: 'custom',
          clientTransport: await legacyUpstream(),
        },
      ],
    });
    const client = await downstream(host);
    const res = await client.callTool({name: 'legacy__greet', arguments: {}});
    expect(res.isError).toBeFalsy();
    expect(text(res)).toContain('hello Ada');
  });

  it('says so when the downstream client cannot be asked', async () => {
    const host = await createMcpHost({
      upstreams: [{name: 'up', transport: 'http', url: await httpUpstream()}],
    });
    const client = await downstream(host, {canElicit: false});
    const outcome = await client
      .callTool({name: 'up__greet', arguments: {}})
      .then(
        r => JSON.stringify(r),
        (e: Error) => e.message,
      );
    expect(outcome).toMatch(/did not declare elicitation/);
  });

  it('with relayElicitation: false the upstream sees a client that cannot be asked', async () => {
    const host = await createMcpHost({
      upstreams: [{name: 'up', transport: 'http', url: await httpUpstream()}],
      relayElicitation: false,
    });
    const client = await downstream(host);
    const res = await client.callTool({name: 'up__greet', arguments: {}});
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('elicitation_unavailable');
  });
});
