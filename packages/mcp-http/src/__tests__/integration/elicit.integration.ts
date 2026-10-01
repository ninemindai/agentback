// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {inject} from '@agentback/core';
import {RestApplication, type RestServer} from '@agentback/rest';
import {
  MCPBindings,
  MCPComponent,
  MCPServer,
  mcpServer,
  tool,
  type Elicitor,
} from '@agentback/mcp';
import {installMcpHttp} from '../../index.js';

// P1-7 phase 2 over real HTTP (docs/proposals/host-extensions.md §5.2): which
// callers can be asked mid-call, on each mount.

const Part = z.object({part: z.enum(['bolt', 'nut'])});

@mcpServer()
class Shop {
  @tool('pick')
  async pick(@inject(MCPBindings.ELICIT) elicit: Elicitor) {
    const {part} = await elicit.ask('part', {
      message: 'Which part?',
      standard: Part,
    });
    return `picked ${part}`;
  }
}

describe('elicitation over mcp-http', () => {
  let app: RestApplication;
  afterEach(async () => app?.stop());

  async function start(protocol: 'both' | 'legacy') {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'elicit-http',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(Shop);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {protocol});
    await app.start();
    return new URL(
      (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
    );
  }

  async function call(url: URL, modern: boolean) {
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      {
        ...(modern ? {versionNegotiation: {mode: 'auto' as const}} : {}),
        capabilities: {elicitation: {}},
      },
    );
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept' as const,
      content: {part: 'nut'},
    }));
    await client.connect(new StreamableHTTPClientTransport(url));
    const r = await client.callTool({name: 'pick', arguments: {}});
    await client.close();
    return (r.content as {text: string}[])[0]!.text;
  }

  it('stateless mount, 2026 client: answered and retried', async () => {
    expect(await call(await start('both'), true)).toBe('picked nut');
  });

  it('stateless mount, 2025 client: elicitation_unavailable, even if declared', async () => {
    // A stateless 2025 request never saw `initialize` and holds no connection
    // to send `elicitation/create` on; the framework says so before the SDK.
    const text = await call(await start('both'), false);
    const {error} = JSON.parse(text) as {
      error: {code: string; message: string};
    };
    expect(error.code).toBe('elicitation_unavailable');
    // The message names the cause and the fix.
    expect(error.message).toMatch(/stateless 2025-era request/);
    expect(error.message).toMatch(/protocol: 'legacy'/);
  });

  it('session mount, 2025 client: the SDK shim asks over the session', async () => {
    expect(await call(await start('legacy'), false)).toBe('picked nut');
  });
});
