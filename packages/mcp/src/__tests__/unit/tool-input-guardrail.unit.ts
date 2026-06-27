// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, tool} from '../../decorators/index.js';

// A union input lowers to a root `anyOf`/`oneOf` JSON Schema — which has no
// `properties` and is not a valid MCP tool inputSchema. Today that silently
// produces a malformed schema (and the confirmation-token injection corrupts
// it further); the guardrail must reject it at registration with a clear,
// tool-named message.
const UnionInput = z.union([
  z.object({city: z.string()}),
  z.object({lat: z.number(), lon: z.number()}),
]);

@mcpServer()
class UnionTool {
  @tool('weather', {input: UnionInput})
  weather(_input: z.infer<typeof UnionInput>) {
    return {ok: true};
  }
}

const ObjectInput = z.object({city: z.string()});

@mcpServer()
class ObjectTool {
  @tool('ok_weather', {input: ObjectInput})
  weather(_input: z.infer<typeof ObjectInput>) {
    return {ok: true};
  }
}

// A discriminated union — the exact "city XOR coordinates" modeling the audit
// flagged. Lowers to a root oneOf, so the guardrail must still reject it.
const DiscriminatedInput = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('city'), city: z.string()}),
  z.object({kind: z.literal('coords'), lat: z.number(), lon: z.number()}),
]);

@mcpServer()
class DiscriminatedTool {
  @tool('disc_weather', {input: DiscriminatedInput})
  weather(_input: z.infer<typeof DiscriminatedInput>) {
    return {ok: true};
  }
}

// An intersection lowers to a root allOf.
const IntersectionInput = z.intersection(
  z.object({a: z.string()}),
  z.object({b: z.number()}),
);

@mcpServer()
class IntersectionTool {
  @tool('inter_weather', {input: IntersectionInput})
  weather(_input: z.infer<typeof IntersectionInput>) {
    return {ok: true};
  }
}

// A bare primitive lowers to a scalar `type`, not an object.
const PrimitiveInput = z.string();

@mcpServer()
class PrimitiveTool {
  @tool('prim_weather', {input: PrimitiveInput})
  weather(_input: z.infer<typeof PrimitiveInput>) {
    return {ok: true};
  }
}

async function serverWith(toolClass: new () => object): Promise<MCPServer> {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'guardrail-test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(toolClass);
  return app.get<MCPServer>('servers.MCPServer');
}

describe('MCP tool inputSchema must lower to an object root', () => {
  it('rejects a union/non-object input schema, naming the tool', async () => {
    const server = await serverWith(UnionTool);
    expect(() => server.buildServer()).toThrow(/weather/);
    expect(() => server.buildServer()).toThrow(/object/i);
  });

  it('accepts a plain object input schema', async () => {
    const server = await serverWith(ObjectTool);
    expect(() => server.buildServer()).not.toThrow();
  });

  it('rejects a discriminated union (oneOf root)', async () => {
    const server = await serverWith(DiscriminatedTool);
    expect(() => server.buildServer()).toThrow(/disc_weather/);
    expect(() => server.buildServer()).toThrow(/oneOf/);
  });

  it('rejects an intersection (allOf root)', async () => {
    const server = await serverWith(IntersectionTool);
    expect(() => server.buildServer()).toThrow(/inter_weather/);
    expect(() => server.buildServer()).toThrow(/allOf/);
  });

  it('rejects a bare primitive (scalar type root)', async () => {
    const server = await serverWith(PrimitiveTool);
    expect(() => server.buildServer()).toThrow(/prim_weather/);
    expect(() => server.buildServer()).toThrow(/non-object `string`/);
  });
});
