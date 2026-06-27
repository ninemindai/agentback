// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';

const Item = z.object({n: z.number()});

// Tracks generator cleanup so a test can assert the `finally` block ran.
const cleanupCalls: string[] = [];

@mcpServer()
class StreamTools {
  // An async generator that is also the shape a `@get(..., {streamOf: Item})`
  // route would expose. Over MCP it drains; `output` is the COLLECTED shape.
  @tool('count_up', {input: z.object({n: z.number().int().min(0)})})
  async *countUp(input: {n: number}) {
    for (let i = 1; i <= input.n; i++) {
      yield {n: i};
    }
  }

  // Empty generator → collected `[]`.
  @tool('emit_none', {input: z.object({})})
  async *emitNone(_input: Record<string, never>) {
    // Yields nothing; the drain collects `[]`.
    if (_input) return;
    yield {n: 0};
  }

  // Output schema validates the COLLECTED array. A bad item fails validation.
  // A streaming tool's method returns an async iterable, so the typed `output:`
  // overload (which constrains the return to the collected `z.array(Item)`)
  // does not statically describe the generator — the collected array is
  // produced by the runtime drain. The `@ts-expect-error` documents that gap.
  // @ts-expect-error streaming return type is AsyncGenerator, not the array
  @tool('count_validated', {
    input: z.object({n: z.number().int().min(0), bad: z.boolean()}),
    output: z.array(Item),
  })
  async *countValidated(input: {n: number; bad: boolean}) {
    for (let i = 1; i <= input.n; i++) {
      // When `bad`, yield an item that violates `Item` (n must be a number).
      yield (input.bad ? {n: 'oops'} : {n: i}) as unknown as {n: number};
    }
  }

  // Generator with a `finally` block — drained normally, the block must run.
  @tool('count_cleanup', {input: z.object({n: z.number().int().min(0)})})
  async *countCleanup(input: {n: number}) {
    try {
      for (let i = 1; i <= input.n; i++) {
        yield {n: i};
      }
    } finally {
      cleanupCalls.push('count_cleanup');
    }
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
  app.service(StreamTools);
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

describe('stream-tools bridge over a transport', () => {
  it('drains a generator into N progress notifications and the collected result', async () => {
    const {server} = await givenServer();
    const {client, sent} = await clientWithWireSpy(server);
    const progresses: Array<{progress: number; message?: string}> = [];
    const result = await client.callTool(
      {name: 'count_up', arguments: {n: 3}},
      undefined,
      {onprogress: p => progresses.push(p)},
    );
    expect(result.isError).toBeFalsy();
    // One progress per yielded item; `progress` is the 1-based index and
    // `message` is a JSON preview. `total` is omitted (unknown for a generator).
    expect(progresses).toEqual([
      {progress: 1, message: JSON.stringify({n: 1})},
      {progress: 2, message: JSON.stringify({n: 2})},
      {progress: 3, message: JSON.stringify({n: 3})},
    ]);
    // The collected array is the tool result.
    const text = (result.content as {type: string; text: string}[])[0].text;
    expect(JSON.parse(text)).toEqual([{n: 1}, {n: 2}, {n: 3}]);
    // Wire check: notifications carried the caller's token.
    const notes = progressOf(sent);
    expect(notes).toHaveLength(3);
    expect(notes[0].params.progressToken).toBeDefined();
    expect(notes[0].params.total).toBeUndefined();
  });
});

describe('stream-tools bridge via the public callTool path', () => {
  it('drains and returns the collected array with the no-op PROGRESS default', async () => {
    const {server} = await givenServer();
    // No transport, no progressToken — PROGRESS resolves to the no-op and the
    // generator still drains without throwing.
    await expect(server.callTool('count_up', {n: 2})).resolves.toEqual([
      {n: 1},
      {n: 2},
    ]);
  });

  it('returns [] for an empty generator', async () => {
    const {server} = await givenServer();
    await expect(server.callTool('emit_none', {})).resolves.toEqual([]);
  });
});

describe('stream-tools output validation', () => {
  it('validates the collected array against output: z.array(Item)', async () => {
    const {server} = await givenServer();
    await expect(
      server.callTool('count_validated', {n: 2, bad: false}),
    ).resolves.toEqual([{n: 1}, {n: 2}]);
  });

  it('rejects a generator yielding a bad item (throw via callTool)', async () => {
    const {server} = await givenServer();
    await expect(
      server.callTool('count_validated', {n: 1, bad: true}),
    ).rejects.toThrow(/Invalid output from tool count_validated/);
  });

  it('surfaces output-validation failure as isError over a transport', async () => {
    const {server} = await givenServer();
    const {client} = await clientWithWireSpy(server);
    const result = await client.callTool({
      name: 'count_validated',
      arguments: {n: 1, bad: true},
    });
    expect(result.isError).toBe(true);
  });
});

describe('stream-tools generator cleanup', () => {
  it('runs the generator finally block when drained normally', async () => {
    cleanupCalls.length = 0;
    const {server} = await givenServer();
    await expect(server.callTool('count_cleanup', {n: 2})).resolves.toEqual([
      {n: 1},
      {n: 2},
    ]);
    expect(cleanupCalls).toEqual(['count_cleanup']);
  });
});
