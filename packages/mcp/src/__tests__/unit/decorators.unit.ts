// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z, type ZodObject, type ZodRawShape} from 'zod';
import {MetadataInspector} from '@agentback/metadata';
import {
  registerJSONSchemaConverter,
  type StandardSchemaV1,
} from '@agentback/openapi';
import {Application} from '@agentback/core';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {mcpServer, prompt, resource, tool} from '../../decorators/index.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {
  MCPKeys,
  MCP_SERVERS,
  PromptMetadata,
  ResourceMetadata,
  ToolMetadata,
} from '../../keys.js';
import {
  createBindingFromClass,
  getBindingMetadata,
  inject,
} from '@agentback/context';
import {extensionFilter} from '@agentback/core';

describe('@mcpServer', () => {
  it('marks the class as an MCP_SERVERS extension via @injectable', () => {
    @mcpServer()
    class Tools {}
    const meta = getBindingMetadata(Tools);
    expect(meta?.templates?.length).toBeGreaterThan(0);
    expect(meta?.target).toBe(Tools);
    // The injectable template tags it `extensionFor: MCP_SERVERS`.
    const binding = createBindingFromClass(Tools);
    expect(extensionFilter(MCP_SERVERS)(binding)).toBe(true);
  });

  it('accepts an optional name', () => {
    @mcpServer('weather-tools')
    class WeatherTools {}
    const meta = getBindingMetadata(WeatherTools);
    expect(meta).toBeDefined();
  });
});

describe('@tool', () => {
  it('records tool metadata with input schema + description + title', () => {
    const Input = z.object({a: z.number(), b: z.number()});
    class Tools {
      @tool('add', {
        description: 'sums two numbers',
        title: 'Adder',
        input: Input,
      })
      add(_input: z.infer<typeof Input>) {}
    }
    const meta = MetadataInspector.getMethodMetadata<ToolMetadata>(
      MCPKeys.TOOL,
      Tools.prototype,
      'add',
    );
    expect(meta?.name).toBe('add');
    expect(meta?.description).toBe('sums two numbers');
    expect(meta?.title).toBe('Adder');
    expect(meta?.methodName).toBe('add');
    expect(meta?.input).toBe(Input);
  });

  it('description and title are optional', () => {
    class Tools {
      @tool('bare', {input: z.object({})})
      bare(_input: {}) {}
    }
    const meta = MetadataInspector.getMethodMetadata<ToolMetadata>(
      MCPKeys.TOOL,
      Tools.prototype,
      'bare',
    );
    expect(meta?.name).toBe('bare');
    expect(meta?.description).toBeUndefined();
    expect(meta?.title).toBeUndefined();
    expect(meta?.input).toBeDefined();
  });

  it('input shape keys are exposed for inputSchema emission', () => {
    const Input = z.object({city: z.string(), days: z.number().int()});
    class Tools {
      @tool('get_forecast', {input: Input})
      forecast(_input: z.infer<typeof Input>) {}
    }
    const meta = MetadataInspector.getMethodMetadata<ToolMetadata>(
      MCPKeys.TOOL,
      Tools.prototype,
      'forecast',
    );
    expect(
      Object.keys((meta!.input as ZodObject<ZodRawShape>).shape).sort(),
    ).toEqual(['city', 'days']);
  });

  it('omitting input is allowed (zero-arg tools)', () => {
    class Tools {
      @tool('ping')
      ping() {
        return 'pong';
      }
    }
    const meta = MetadataInspector.getMethodMetadata<ToolMetadata>(
      MCPKeys.TOOL,
      Tools.prototype,
      'ping',
    );
    expect(meta?.input).toBeUndefined();
    expect(meta?.name).toBe('ping');
  });

  it('throws at decoration time when @inject is on slot 0 alongside input', () => {
    expect(() => {
      class _Bad {
        @tool('bad', {input: z.object({n: z.number()})})
        bad(@inject('svc') _svc: unknown) {}
      }
      // reference to silence unused
      void _Bad;
    }).toThrow(/slot 0 is reserved for the validated input bundle/);
  });
});

describe('@resource', () => {
  it('records resource URI + name + mimeType', () => {
    class Tools {
      @resource('weather://stations/{id}', {
        name: 'station',
        description: 'A station',
        mimeType: 'application/json',
      })
      station() {}
    }
    const meta = MetadataInspector.getMethodMetadata<ResourceMetadata>(
      MCPKeys.RESOURCE,
      Tools.prototype,
      'station',
    );
    expect(meta).toMatchObject({
      uri: 'weather://stations/{id}',
      name: 'station',
      mimeType: 'application/json',
      methodName: 'station',
    });
  });

  it('defaults the name to the method name', () => {
    class Tools {
      @resource('w://x')
      myResource() {}
    }
    const meta = MetadataInspector.getMethodMetadata<ResourceMetadata>(
      MCPKeys.RESOURCE,
      Tools.prototype,
      'myResource',
    );
    expect(meta?.name).toBe('myResource');
  });
});

describe('@prompt', () => {
  it('records prompt metadata', () => {
    class Tools {
      @prompt('summary', {description: 'summarize'})
      summary() {}
    }
    const meta = MetadataInspector.getMethodMetadata<PromptMetadata>(
      MCPKeys.PROMPT,
      Tools.prototype,
      'summary',
    );
    expect(meta).toEqual({
      name: 'summary',
      description: 'summarize',
      methodName: 'summary',
    });
  });
});

describe('MCP_SERVERS extension point', () => {
  it('exports the canonical extension-point name', () => {
    expect(MCP_SERVERS).toBe('mcpServers');
  });
});

describe('@tool with Standard Schema (non-Zod) schemas', () => {
  /**
   * A minimal Standard Schema V1 vendor — validates an object whose declared
   * keys must be strings. Mimics a Valibot-style library: validates fine but
   * has no native JSON Schema emission, so a converter is registered for the
   * vendor (same pattern as openapi's standard-schema.unit.ts).
   */
  function fakeObjectSchema(
    keys: string[],
  ): StandardSchemaV1<unknown, Record<string, string>> {
    const schema = {
      __keys: keys,
      '~standard': {
        version: 1 as const,
        vendor: 'fake-mcp',
        validate(value: unknown) {
          if (value == null || typeof value !== 'object') {
            return {issues: [{message: 'expected an object'}]};
          }
          const out: Record<string, string> = {};
          for (const k of keys) {
            const v = (value as Record<string, unknown>)[k];
            if (typeof v !== 'string') {
              return {
                issues: [{message: `expected string at ${k}`, path: [k]}],
              };
            }
            out[k] = v;
          }
          return {value: out};
        },
      },
    };
    return schema;
  }

  registerJSONSchemaConverter('fake-mcp', schema => {
    const keys = (schema as unknown as {__keys: string[]}).__keys;
    return {
      type: 'object',
      properties: Object.fromEntries(keys.map(k => [k, {type: 'string'}])),
      required: keys,
    };
  });

  const StdIn = fakeObjectSchema(['city']);

  it('accepts a non-Zod Standard Schema at decoration time', () => {
    expect(() => {
      class T {
        @tool('std_ok', {input: StdIn})
        stdOk(input: Record<string, string>) {
          return {city: input.city};
        }
      }
      void T;
    }).not.toThrow();
  });

  it('registers, validates via ~standard, and lists JSON-Schema inputSchema', async () => {
    @mcpServer()
    class StdTools {
      @tool('std_echo', {input: StdIn, description: 'standard-schema tool'})
      stdEcho(input: Record<string, string>) {
        return {echoed: input.city};
      }
    }
    const app = new Application();
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'std-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(StdTools);
    const server = await app.get<MCPServer>('servers.MCPServer');

    // tools/list carries the converter-emitted JSON Schema.
    const sdkServer = server.buildServer();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await sdkServer.connect(serverTransport);
    const client = new Client({name: 'test-client', version: '0.0.0'});
    await client.connect(clientTransport);
    const {tools} = await client.listTools();
    const listed = tools.find(t => t.name === 'std_echo')!;
    expect(listed).toBeDefined();
    expect(listed.inputSchema).toMatchObject({
      type: 'object',
      properties: {city: {type: 'string'}},
      required: ['city'],
    });

    // ~standard validation: valid input dispatches, invalid is rejected.
    const ok = await client.callTool({
      name: 'std_echo',
      arguments: {city: 'Oslo'},
    });
    expect(ok.isError).toBeFalsy();
    expect(
      JSON.parse((ok.content as {type: string; text: string}[])[0].text),
    ).toEqual({echoed: 'Oslo'});

    const bad = await client.callTool({
      name: 'std_echo',
      arguments: {city: 42},
    });
    expect(bad.isError).toBe(true);
    expect((bad.content as {type: string; text: string}[])[0].text).toMatch(
      /Invalid input for tool std_echo: city: expected string at city/,
    );

    // The in-process path validates through ~standard too.
    await expect(
      server.callTool('std_echo', {city: 7 as never}),
    ).rejects.toThrow(/Invalid input for tool std_echo: city/);
    await client.close();
  });
});
