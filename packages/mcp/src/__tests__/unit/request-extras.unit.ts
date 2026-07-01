// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it, vi} from 'vitest';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import type {JSONRPCMessage} from '@modelcontextprotocol/client';
import {z} from 'zod';
import {inject} from '@agentback/context';
import {Application} from '@agentback/core';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer, progressFnFor} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';
import {
  MCPBindings,
  noopProgress,
  type ProgressFn,
  type ToolRequestExtra,
} from '../../keys.js';

const JobIn = z.object({steps: z.number().int().min(1)});

@mcpServer()
class ExtraTools {
  @tool('long_job', {input: JobIn})
  async longJob(
    input: z.infer<typeof JobIn>,
    @inject(MCPBindings.PROGRESS) progress: ProgressFn,
  ) {
    for (let i = 1; i <= input.steps; i++) {
      await progress({progress: i, total: input.steps, message: `step ${i}`});
    }
    return {done: input.steps};
  }

  @tool('who_extra')
  whoExtra(
    @inject(MCPBindings.REQUEST_EXTRA, {optional: true})
    extra?: ToolRequestExtra,
  ) {
    return {hasExtra: !!extra, requestId: extra?.mcpReq.id ?? null};
  }
}

async function givenServer() {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(ExtraTools);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server};
}

/** Connect a client over InMemoryTransport, spying on server→client traffic. */
async function clientWithWireSpy(server: MCPServer) {
  const sdkServer = server.buildServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const sent: JSONRPCMessage[] = [];
  const origSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (msg, opts) => {
    sent.push(msg);
    return origSend(msg, opts);
  };
  await sdkServer.connect(serverTransport);
  const client = new Client({name: 'test-client', version: '0.0.0'});
  await client.connect(clientTransport);
  return {client, sent};
}

const progressOf = (sent: JSONRPCMessage[]) =>
  sent.filter(
    m => 'method' in m && m.method === 'notifications/progress',
  ) as Array<{method: string; params: Record<string, unknown>}>;

describe('progressFnFor', () => {
  it('relays notifications/progress when a progressToken is present', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const fn = progressFnFor({
      mcpReq: {notify, _meta: {progressToken: 'tok-1'}},
    } as unknown as ToolRequestExtra);
    await fn({progress: 2, total: 5, message: 'halfway-ish'});
    expect(notify).toHaveBeenCalledExactlyOnceWith({
      method: 'notifications/progress',
      params: {
        progressToken: 'tok-1',
        progress: 2,
        total: 5,
        message: 'halfway-ish',
      },
    });
  });

  it('returns the shared no-op when no progressToken was sent', async () => {
    const notify = vi.fn();
    const fn = progressFnFor({
      mcpReq: {notify, _meta: {}},
    } as unknown as ToolRequestExtra);
    expect(fn).toBe(noopProgress);
    await fn({progress: 1});
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('PROGRESS injection over a transport', () => {
  it('relays progress end-to-end when the caller requests it', async () => {
    const {server} = await givenServer();
    const {client, sent} = await clientWithWireSpy(server);
    const progresses: unknown[] = [];
    const result = await client.callTool(
      {name: 'long_job', arguments: {steps: 3}},
      {onprogress: p => progresses.push(p)},
    );
    expect(result.isError).toBeFalsy();
    expect(progresses).toEqual([
      {progress: 1, total: 3, message: 'step 1'},
      {progress: 2, total: 3, message: 'step 2'},
      {progress: 3, total: 3, message: 'step 3'},
    ]);
    // Wire check: notifications carried the caller's token.
    const notes = progressOf(sent);
    expect(notes).toHaveLength(3);
    expect(notes[0].params.progressToken).toBeDefined();
  });

  it('is a no-op (no notifications) when the caller sent no token', async () => {
    const {server} = await givenServer();
    const {client, sent} = await clientWithWireSpy(server);
    const result = await client.callTool({
      name: 'long_job',
      arguments: {steps: 2},
    });
    expect(result.isError).toBeFalsy();
    expect(progressOf(sent)).toHaveLength(0);
  });
});

describe('PROGRESS app-level default (no extras entry paths)', () => {
  it('callTool resolves the no-op default — no ResolutionError', async () => {
    const {server} = await givenServer();
    await expect(server.callTool('long_job', {steps: 2})).resolves.toEqual({
      done: 2,
    });
  });

  it('binds the default on the app, not per request', async () => {
    const {app} = await givenServer();
    expect(app.contains(MCPBindings.PROGRESS.key)).toBe(true);
    await expect(app.get(MCPBindings.PROGRESS)).resolves.toBe(noopProgress);
  });
});

describe('REQUEST_EXTRA', () => {
  it('is injectable on transport-driven calls', async () => {
    const {server} = await givenServer();
    const {client} = await clientWithWireSpy(server);
    const result = await client.callTool({name: 'who_extra', arguments: {}});
    const out = JSON.parse(
      (result.content as {type: string; text: string}[])[0].text,
    );
    expect(out.hasExtra).toBe(true);
    expect(out.requestId).not.toBeNull();
  });

  it('stays optional — undefined via callTool, and no app-level default', async () => {
    const {app, server} = await givenServer();
    await expect(server.callTool('who_extra', {})).resolves.toEqual({
      hasExtra: false,
      requestId: null,
    });
    expect(app.contains(MCPBindings.REQUEST_EXTRA.key)).toBe(false);
  });
});
