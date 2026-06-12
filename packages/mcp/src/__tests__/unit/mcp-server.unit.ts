// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z, type ZodObject, type ZodRawShape} from 'zod';
import {inject} from '@agentback/context';
import {Application} from '@agentback/core';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {mcpServer, prompt, resource, tool} from '../../decorators/index.js';

const EchoInput = z.object({text: z.string().min(1)});
const AddInput = z.object({a: z.number().int(), b: z.number().int()});
const AddOutput = z.object({sum: z.number().int()});
const BadOutput = z.object({mustExist: z.string()});

@mcpServer()
class EchoTools {
  @tool('echo', {description: 'echo back', input: EchoInput})
  echo(input: z.infer<typeof EchoInput>) {
    return {echoed: input.text};
  }

  @tool('add', {input: AddInput, output: AddOutput})
  add(input: z.infer<typeof AddInput>): z.infer<typeof AddOutput> {
    return {sum: input.a + input.b};
  }

  // Method returns nothing matching BadOutput — exercises runtime validation.
  @tool('broken', {input: EchoInput, output: BadOutput})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broken(_input: z.infer<typeof EchoInput>): any {
    return {wrong: 'shape'};
  }

  @resource('w://x', {description: 'a resource'})
  myResource() {
    return 'hello';
  }

  @prompt('greet', {description: 'greeting prompt'})
  greet() {
    return 'hi';
  }
}

describe('MCPServer', () => {
  let app: Application;
  let server: MCPServer;

  beforeEach(async () => {
    app = new Application();
    app.component(MCPComponent);
    // Disable stdio so MCPServer is constructible without taking over stdin
    app.configure('servers.MCPServer').to({
      name: 'test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(EchoTools);
    server = await app.get<MCPServer>('servers.MCPServer');
  });

  afterEach(async () => {
    if (server.listening) await server.stop();
  });

  describe('introspection', () => {
    it('listTools returns every @tool method on bound classes', () => {
      const tools = server.listTools();
      expect(tools.map(t => t.meta.name).sort()).toEqual([
        'add',
        'broken',
        'echo',
      ]);
    });

    it('exposes the output shape when set', () => {
      const add = server.listTools().find(t => t.meta.name === 'add')!;
      expect(add.meta.output).toBeDefined();
      expect(
        Object.keys((add.meta.output as ZodObject<ZodRawShape>).shape),
      ).toEqual(['sum']);
    });

    it('output schema is absent when not declared', () => {
      const echo = server.listTools().find(t => t.meta.name === 'echo')!;
      expect(echo.meta.output).toBeUndefined();
    });

    it('listResources returns every @resource method', () => {
      const resources = server.listResources();
      expect(resources.map(r => r.meta.uri)).toEqual(['w://x']);
    });

    it('listPrompts returns every @prompt method', () => {
      const prompts = server.listPrompts();
      expect(prompts.map(p => p.meta.name)).toEqual(['greet']);
    });

    it('exposes the input shape per tool', () => {
      const add = server.listTools().find(t => t.meta.name === 'add')!;
      expect(
        Object.keys((add.meta.input as ZodObject<ZodRawShape>).shape).sort(),
      ).toEqual(['a', 'b']);
    });
  });

  describe('callTool', () => {
    it('validates input + dispatches', async () => {
      const result = await server.callTool('echo', {text: 'hi'});
      expect(result).toEqual({echoed: 'hi'});
    });

    it('rejects invalid input with the failing path', async () => {
      await expect(server.callTool('echo', {text: ''})).rejects.toThrow(
        /Invalid input for tool echo: text/,
      );
    });

    it('rejects missing keys', async () => {
      await expect(server.callTool('echo', {})).rejects.toThrow(
        /Invalid input for tool echo/,
      );
    });

    it('rejects unknown tool names', async () => {
      await expect(server.callTool('nope', {})).rejects.toThrow(/Unknown tool/);
    });

    it('passes the parsed input object to the method', async () => {
      const result = await server.callTool('add', {a: 2, b: 40});
      expect(result).toEqual({sum: 42});
    });

    it('validates the return value when an output schema is set', async () => {
      await expect(server.callTool('broken', {text: 'hi'})).rejects.toThrow(
        /Invalid output from tool broken: mustExist/,
      );
    });

    it('surfaces Zod issues on the thrown error', async () => {
      let thrown: unknown;
      try {
        await server.callTool('echo', {text: ''});
      } catch (e) {
        thrown = e;
      }
      const issues = (thrown as Error & {issues: unknown[]}).issues;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues[0]).toMatchObject({code: 'too_small'});
    });
  });

  describe('readResource', () => {
    it('returns the MCP contents shape, defaulting mimeType', async () => {
      const result = await server.readResource('myResource');
      expect(result).toEqual({
        contents: [{uri: 'w://x', mimeType: 'text/plain', text: 'hello'}],
      });
    });

    it('throws on an unknown resource', async () => {
      await expect(server.readResource('nope')).rejects.toThrow(
        /Unknown resource/,
      );
    });
  });

  describe('getPrompt', () => {
    it('returns the MCP messages shape', async () => {
      const result = await server.getPrompt('greet');
      expect(result).toEqual({
        messages: [{role: 'user', content: {type: 'text', text: 'hi'}}],
      });
    });

    it('throws on an unknown prompt', async () => {
      await expect(server.getPrompt('nope')).rejects.toThrow(/Unknown prompt/);
    });
  });

  describe('lifecycle', () => {
    it('start() with stdio disabled does not take over stdin', async () => {
      await server.start();
      expect(server.listening).toBe(true);
      await server.stop();
      expect(server.listening).toBe(false);
    });
  });
});

describe('MCPServer @inject weaving', () => {
  class Clock {
    iso = '2026-05-18T00:00:00.000Z';
  }

  const StampInput = z.object({label: z.string().min(1)});

  @mcpServer()
  class StampedTools {
    @tool('stamp', {input: StampInput})
    stamp(
      input: z.infer<typeof StampInput>,
      @inject('services.clock') clock: Clock,
    ) {
      return {label: input.label, at: clock.iso};
    }

    @tool('whoami')
    whoami(@inject('services.clock') clock: Clock) {
      return {at: clock.iso};
    }
  }

  let app: Application;
  let server: MCPServer;
  beforeEach(async () => {
    app = new Application();
    app.bind('services.clock').toClass(Clock);
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'inject-test',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(StampedTools);
    server = await app.get<MCPServer>('servers.MCPServer');
  });
  afterEach(async () => {
    if (server.listening) await server.stop();
  });

  it('injects services at slot 1+ alongside the validated input', async () => {
    const result = await server.callTool('stamp', {label: 'go'});
    expect(result).toEqual({label: 'go', at: '2026-05-18T00:00:00.000Z'});
  });

  it('allows @inject at slot 0 when no input schema is declared', async () => {
    const result = await server.callTool('whoami', {});
    expect(result).toEqual({at: '2026-05-18T00:00:00.000Z'});
  });
});

describe('MCPServer with config injection', () => {
  it('honors configured name + version', async () => {
    const app = new Application();
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'configured-name',
      version: '9.9.9',
      transports: {stdio: false},
    });
    const server = await app.get<MCPServer>('servers.MCPServer');
    expect(server.config.name).toBe('configured-name');
    expect(server.config.version).toBe('9.9.9');
  });
});
