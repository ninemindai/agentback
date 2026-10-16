// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {authorize} from '@agentback/authorization';
import {
  MCPBindings,
  MCPComponent,
  mcpServer,
  tool,
  type MCPServer,
} from '@agentback/mcp';
import {buildCli} from '../../build-cli.js';

const ForecastIn = z.object({
  city: z.string().min(1),
  days: z.number().default(1),
});
const ForecastOut = z.object({
  city: z.string(),
  days: z.number(),
  tempC: z.number(),
});

@mcpServer()
class WeatherTools {
  @tool('forecast', {
    description: 'Weather forecast for a city.',
    input: ForecastIn,
    output: ForecastOut,
  })
  forecast(input: z.infer<typeof ForecastIn>) {
    return {city: input.city, days: input.days, tempC: 18};
  }

  @authorize({scopes: ['admin:ops']})
  @tool('secret', {description: 'Scoped tool.'})
  secret() {
    return {ok: true};
  }

  // App-only (MCP Apps ui.visibility): a host's app surface calls it; the
  // CLI has no app surface, so it is not a command.
  @tool('refresh', {
    description: 'Refresh the widget.',
    ui: {visibility: ['app']},
  })
  refresh() {
    return {ok: true};
  }

  @tool('count', {
    description: 'Count up to n (a streaming tool).',
    input: z.object({to: z.number()}),
  })
  async *count(input: {to: number}) {
    for (let i = 1; i <= input.to; i++) yield {n: i};
  }
}

async function givenStartedApp(): Promise<Application> {
  const app = new Application();
  app.component(MCPComponent);
  app.service(WeatherTools);
  await app.start();
  return app;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (s: string) => out.push(s),
      stderr: (s: string) => err.push(s),
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

describe('buildCli — cross-surface identity (eng review T4)', () => {
  it('CLI result equals the same tool called over MCP (one source of truth)', async () => {
    const app = await givenStartedApp();
    const mcp = await app.get<MCPServer>(MCPBindings.SERVER.key);
    const run = await buildCli(app, {include: ['forecast']});
    const cap = capture();

    const code = await run(
      ['forecast', '--city', 'Tokyo', '--days', '3'],
      cap.io,
    );

    expect(code).toBe(0);
    const cliResult = JSON.parse(cap.stdout());
    const mcpResult = await mcp.callTool(
      'forecast',
      {city: 'Tokyo', days: 3},
      {},
    );
    expect(cliResult).toEqual(mcpResult);
    await app.stop();
  });

  it('coerces a z.number() flag authored for a JSON body (the T1 regression)', async () => {
    const app = await givenStartedApp();
    const run = await buildCli(app, {include: ['forecast']});
    const cap = capture();
    const code = await run(
      ['forecast', '--city', 'Osaka', '--days', '5'],
      cap.io,
    );
    expect(code).toBe(0);
    expect(JSON.parse(cap.stdout())).toMatchObject({city: 'Osaka', days: 5});
    await app.stop();
  });

  it('applies the schema default when a flag is omitted', async () => {
    const app = await givenStartedApp();
    const run = await buildCli(app, {include: ['forecast']});
    const cap = capture();
    await run(['forecast', '--city', 'Kyoto'], cap.io);
    expect(JSON.parse(cap.stdout())).toMatchObject({city: 'Kyoto', days: 1});
    await app.stop();
  });

  it('unknown command exits non-zero', async () => {
    const app = await givenStartedApp();
    const run = await buildCli(app, {include: ['forecast']});
    expect(await run(['nope'], capture().io)).toBe(1);
    await app.stop();
  });

  it('a bad flag exits non-zero with an AgentError envelope on stderr', async () => {
    const app = await givenStartedApp();
    const run = await buildCli(app, {include: ['forecast']});
    const cap = capture();
    const code = await run(
      ['forecast', '--city', 'Tokyo', '--bogus', 'x'],
      cap.io,
    );
    expect(code).toBe(1);
    expect(cap.stdout()).toBe(''); // success stream stays empty on failure
    expect(JSON.parse(cap.stderr())).toMatchObject({code: expect.any(String)});
    await app.stop();
  });

  it('an invalid --format value is rejected', async () => {
    const app = await givenStartedApp();
    const run = await buildCli(app, {include: ['forecast']});
    const cap = capture();
    const code = await run(
      ['forecast', '--city', 'Tokyo', '--format', 'yaml'],
      cap.io,
    );
    expect(code).toBe(1);
    await app.stop();
  });

  it('streams a streamOf tool incrementally as NDJSON, not one buffered array', async () => {
    const app = await givenStartedApp();
    const run = await buildCli(app, {include: ['count']});
    const cap = capture();
    const code = await run(['count', '--to', '3'], cap.io);
    expect(code).toBe(0);
    const lines = cap.stdout().trim().split('\n');
    expect(lines).toHaveLength(3); // one JSON object per line, not a single array
    expect(JSON.parse(lines[0])).toEqual({n: 1});
    expect(JSON.parse(lines[2])).toEqual({n: 3});
    await app.stop();
  });

  it('leaves an app-only tool out of the commands, help and --llms', async () => {
    const app = await givenStartedApp();
    const run = await buildCli(app);

    const help = capture();
    expect(await run(['--help'], help.io)).toBe(0);
    expect(help.stdout()).toContain('forecast');
    expect(help.stdout()).not.toContain('refresh');

    expect(await run(['refresh'], capture().io)).toBe(1);

    const llms = capture();
    expect(await run(['--llms'], llms.io)).toBe(0);
    const names = JSON.parse(llms.stdout()).tools.map(
      (t: {name: string}) => t.name,
    );
    expect(names).toContain('forecast');
    expect(names).not.toContain('refresh');
    await app.stop();
  });

  it('throws when an include list names an app-only tool', async () => {
    const app = await givenStartedApp();
    await expect(buildCli(app, {include: ['refresh']})).rejects.toThrow(
      /tool 'refresh' is app-only/,
    );
    await app.stop();
  });

  it('--llms prints a machine-readable manifest of the selected tools only', async () => {
    const app = await givenStartedApp();
    const run = await buildCli(app, {include: ['forecast']});
    const cap = capture();
    const code = await run(['--llms'], cap.io);
    expect(code).toBe(0);
    const manifest = JSON.parse(cap.stdout());
    const names = manifest.tools.map((t: {name: string}) => t.name);
    expect(names).toContain('forecast');
    expect(names).not.toContain('secret'); // not in the include list
    await app.stop();
  });
});
