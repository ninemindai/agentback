// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/
import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {mcpServer, tool} from '../../decorators/index.js';
import {MCPComponent} from '../../mcp.component.js';
import {MCPServer} from '../../mcp.server.js';
import {
  estimateTokens,
  formatToolCostReport,
  toolCostReport,
} from '../../tool-cost.js';

const EchoIn = z.object({text: z.string().min(1)});
const DeployIn = z.object({env: z.string()});

@mcpServer()
class AgentContractTools {
  @tool('echo', {input: EchoIn, description: 'Echo the text back'})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('deploy', {input: DeployIn, confirm: true, description: 'Dangerous'})
  deploy(input: z.infer<typeof DeployIn>) {
    return {deployed: input.env};
  }

  @tool('explode', {description: 'Throws an accidental internal error'})
  explode(): unknown {
    throw new Error('internal token leaked');
  }
}

async function makeServer(): Promise<MCPServer> {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'agent-contract-test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(AgentContractTools);
  return app.get<MCPServer>('servers.MCPServer');
}

async function makeClient(server: MCPServer): Promise<Client> {
  const sdkServer = server.buildServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await sdkServer.connect(serverTransport);
  const client = new Client({name: 'test-client', version: '0.0.0'});
  await client.connect(clientTransport);
  return client;
}

describe('tool cost report (L-3)', () => {
  it('estimates tokens at ~chars/4', () => {
    expect(estimateTokens('abcd'.repeat(10))).toBe(10);
    expect(estimateTokens('abc')).toBe(1);
  });

  it('prices every tool and totals the surface', async () => {
    const server = await makeServer();
    const report = server.toolCostReport();
    expect(report.tools.map(t => t.name).sort()).toEqual([
      'deploy',
      'echo',
      'explode',
    ]);
    expect(report.totalTokens).toBe(
      report.tools.reduce((sum, t) => sum + t.tokens, 0),
    );
    for (const t of report.tools) {
      expect(t.tokens).toBeGreaterThan(0);
      expect(t.bytes).toBeGreaterThanOrEqual(t.tokens * 3);
    }
    // Sorted most-expensive first.
    const tokens = report.tools.map(t => t.tokens);
    expect([...tokens].sort((a, b) => b - a)).toEqual(tokens);
  });

  it('formats an aligned report with a total row and over-budget flags', () => {
    const report = toolCostReport([
      {name: 'small', description: 'ok', inputSchema: {type: 'object'}},
      {
        name: 'huge',
        description: 'x'.repeat(4000),
        inputSchema: {type: 'object'},
      },
    ]);
    const text = formatToolCostReport(report);
    expect(text).toContain('huge');
    expect(text).toContain('total');
    expect(text).toContain('⚠ over budget');
  });
});

describe('MCP error envelope (L-2)', () => {
  it('invalid input surfaces the machine-actionable envelope', async () => {
    const server = await makeServer();
    const client = await makeClient(server);
    const bad = await client.callTool({name: 'echo', arguments: {text: 7}});
    expect(bad.isError).toBe(true);
    const {error} = JSON.parse(
      (bad.content as {type: string; text: string}[])[0].text,
    );
    expect(error.code).toBe('invalid_input');
    expect(error.retryable).toBe(true);
    expect(error.hint).toMatch(/Fix the listed issues/);
    expect(error.issues[0]).toMatchObject({path: ['text']});
    expect(error.schema).toMatchObject({
      type: 'object',
      properties: {text: {type: 'string'}},
    });
    await client.close();
  });

  it('accidental internal errors are sanitized', async () => {
    const server = await makeServer();
    const client = await makeClient(server);
    const result = await client.callTool({name: 'explode', arguments: {}});
    expect(result.isError).toBe(true);
    const text = (result.content as {type: string; text: string}[])[0].text;
    const {error} = JSON.parse(text);
    expect(error.code).toBe('internal_error');
    expect(error.message).toBe('Internal Server Error');
    expect(text).not.toContain('internal token leaked');
    await client.close();
  });
});

describe('confirm: tools (L-4)', () => {
  it('advertises confirmationToken in the inputSchema', async () => {
    const server = await makeServer();
    const client = await makeClient(server);
    const {tools} = await client.listTools();
    const deploy = tools.find(t => t.name === 'deploy')!;
    expect(
      (deploy.inputSchema.properties as Record<string, unknown>)
        .confirmationToken,
    ).toMatchObject({type: 'string'});
    const echo = tools.find(t => t.name === 'echo')!;
    expect(
      (echo.inputSchema.properties as Record<string, unknown>)
        .confirmationToken,
    ).toBeUndefined();
    await client.close();
  });

  it('requires a confirmation round-trip with an identical payload', async () => {
    const server = await makeServer();
    const client = await makeClient(server);

    const first = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod'},
    });
    expect(first.isError).toBe(true);
    const firstError = JSON.parse(
      (first.content as {type: string; text: string}[])[0].text,
    ).error;
    expect(firstError.code).toBe('confirmation_required');
    expect(firstError.retryable).toBe(true);
    const token = firstError.confirmationToken;
    expect(token).toBeTruthy();

    // Tampered payload with a valid token is refused.
    const tampered = await client.callTool({
      name: 'deploy',
      arguments: {env: 'staging', confirmationToken: token},
    });
    expect(
      JSON.parse((tampered.content as {type: string; text: string}[])[0].text)
        .error.code,
    ).toBe('confirmation_invalid');

    // A fresh token with the identical payload executes.
    const second = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod'},
    });
    const freshToken = JSON.parse(
      (second.content as {type: string; text: string}[])[0].text,
    ).error.confirmationToken;
    const confirmed = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod', confirmationToken: freshToken},
    });
    expect(confirmed.isError).toBeFalsy();
    expect(
      JSON.parse((confirmed.content as {type: string; text: string}[])[0].text),
    ).toEqual({deployed: 'prod'});

    await client.close();
  });

  it('enforces confirmation on the in-process callTool path too', async () => {
    const server = await makeServer();
    await expect(server.callTool('deploy', {env: 'dev'})).rejects.toMatchObject(
      {code: 'confirmation_required'},
    );
  });
});
