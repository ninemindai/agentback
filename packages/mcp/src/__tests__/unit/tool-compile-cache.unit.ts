// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {Application} from '@agentback/core';
import {MCPComponent, MCPServer, mcpServer, tool} from '../../index.js';

// `buildServer()` mints a fresh SDK server for every serving unit — today one
// per Streamable-HTTP session, and under the 2026-07-28 stateless revision one
// per REQUEST (docs/proposals/mcp-2026-stateless.md). Emitting every tool's
// JSON Schema on each of those measured ~6ms for 100 tools, which caps a single
// core near 166 req/s on server construction alone. The emission is
// deterministic per tool, so it is compiled once per (class, method).
//
// These tests assert the CACHE, not a duration: a timing assertion would be
// flaky on shared CI runners and would not actually prove the mechanism. A
// schema that counts its own emissions proves it exactly.

/** A Standard Schema that counts how many times its JSON Schema was emitted. */
function countingSchema(shape: Record<string, unknown>) {
  const self = {
    emissions: 0,
    '~standard': {
      version: 1 as const,
      vendor: 'agentback-test',
      validate: (value: unknown) => ({value}),
    },
    // The capability `schemaToOpenApiSchema` prefers for non-Zod vendors
    // (zod-bridge.ts) — the natural seam for counting emissions.
    toJsonSchema() {
      self.emissions++;
      return {type: 'object', properties: shape};
    },
  };
  return self;
}

const In = countingSchema({city: {type: 'string'}});
const Out = countingSchema({temp: {type: 'number'}});

@mcpServer()
class Tools {
  @tool('forecast', {input: In, output: Out})
  forecast(_input: unknown) {
    return {temp: 1};
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
  app.service(Tools);
  return app.get<MCPServer>('servers.MCPServer');
}

describe('tool compile cache', () => {
  it('emits each schema at most once across many buildServer() calls', async () => {
    const before = {input: In.emissions, output: Out.emissions};
    const server = await givenServer();

    for (let i = 0; i < 5; i++) server.buildServer();

    // <=1 rather than ==1: the schemas are module scoped, so a sibling test may
    // already have warmed the cache depending on execution order.
    expect(In.emissions - before.input).toBeLessThanOrEqual(1);
    expect(Out.emissions - before.output).toBeLessThanOrEqual(1);
  });

  it('shares the cache across MCPServer instances', async () => {
    // The case that matters for stateless serving: every request resolves its
    // OWN MCPServer, so an instance-level cache would never hit. Warm it, then
    // prove a brand-new instance pays nothing.
    (await givenServer()).buildServer();
    const warm = {input: In.emissions, output: Out.emissions};

    const fresh = await givenServer();
    fresh.buildServer();
    fresh.buildServer();

    expect(In.emissions).toBe(warm.input);
    expect(Out.emissions).toBe(warm.output);
  });

  it('still publishes the emitted schema over the wire', async () => {
    // Compiled entries are frozen and shared by every caller. This proves the
    // SDK round-trips them intact — if it needed to mutate a tool entry, the
    // freeze would throw here rather than silently bleed across callers.
    const server = await givenServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.buildServer().connect(serverTransport);
    const client = new Client({name: 'test-client', version: '0.0.0'});
    await client.connect(clientTransport);

    // Reaching the client at all is the assertion: serving `tools/list` from a
    // frozen entry would throw at the SDK's first write attempt. What the
    // client holds is a deserialized copy, so it is deliberately NOT checked
    // for frozen-ness — only the server-side original is shared and frozen.
    const {tools} = await client.listTools();
    const listed = tools.find(t => t.name === 'forecast')!;
    expect(listed.inputSchema).toMatchObject({
      type: 'object',
      properties: {city: {type: 'string'}},
    });
    await client.close();
  });

  it('does not cache a failure, so a bad schema keeps failing every build', async () => {
    // The object-root guard must keep throwing on every buildServer(), or a bad
    // schema would fail once at app.start() and then be silently skipped.
    const bad = countingSchema({});
    bad.toJsonSchema = () => ({type: 'string'}) as never;

    @mcpServer()
    class BadTools {
      @tool('bad', {input: bad})
      bad(_input: unknown) {
        return {};
      }
    }
    const app = new Application();
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'bad',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(BadTools);
    const server = await app.get<MCPServer>('servers.MCPServer');

    expect(() => server.buildServer()).toThrow(/must be an object/);
    expect(() => server.buildServer()).toThrow(/must be an object/);
  });
});
