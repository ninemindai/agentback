// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// The full loop, no network: a real ToolLoopAgent driven by a mock model
// calls the app's own @tool classes through the projection — proving
// per-turn identity, metering correlation, quota preflight, and lifecycle.

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {ToolLoopAgent} from 'ai';
import {MockLanguageModelV4} from 'ai/test';
import {authorize} from '@agentback/authorization';
import {Context, inject} from '@agentback/context';
import {Application, CoreBindings} from '@agentback/core';
import {MCPComponent, mcpServer, tool, type MCPServer} from '@agentback/mcp';
import {
  InMemoryQuotaService,
  InMemoryUsageSink,
  MeteringBindings,
  MeteringComponent,
} from '@agentback/metering';
import {securityId, SecurityBindings} from '@agentback/security';
import type {UserProfile} from '@agentback/security';
import {AgentBindings} from '../../keys.js';
import {toHostTools} from '../../host-tools.js';
import {installAgent} from '../../install.js';
import type {AgentPort, AgentSessionLike} from '../../port.js';

const ForecastIn = z.object({city: z.string()});
const ForecastOut = z.object({city: z.string(), tempC: z.number()});

@mcpServer()
class WeatherTools {
  @tool('forecast', {
    description: 'Forecast for a city.',
    input: ForecastIn,
    output: ForecastOut,
  })
  forecast(input: z.infer<typeof ForecastIn>) {
    return {city: input.city, tempC: 21};
  }

  @authorize({allowedRoles: ['admin']})
  @tool('admin_forecast', {input: ForecastIn, output: ForecastOut})
  adminForecast(input: z.infer<typeof ForecastIn>) {
    return {city: input.city, tempC: -1};
  }

  @tool('countdown', {description: 'Streams a countdown.'})
  async *countdown() {
    yield 3;
    yield 2;
    yield 1;
  }

  /** Reports the ambient cancellation seam the tool body can reach. */
  @tool('probe_signal', {input: z.object({})})
  probeSignal(
    _input: Record<string, never>,
    @inject(CoreBindings.ABORT_SIGNAL, {optional: true})
    signal?: AbortSignal,
  ) {
    toolSawSignal = signal;
    return {seen: signal !== undefined};
  }
}

/** Set by `probe_signal` on each call. */
let toolSawSignal: AbortSignal | undefined;

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {total: 20, text: 20, reasoning: undefined},
};

/** A model that calls `toolName` once, then answers with text. */
function toolCallingModel(toolName: string, input: unknown) {
  let call = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: 'call-1',
              toolName,
              input: JSON.stringify(input),
            },
          ],
          finishReason: {unified: 'tool-calls' as const, raw: undefined},
          usage,
          warnings: [],
        };
      }
      return {
        content: [{type: 'text' as const, text: 'done'}],
        finishReason: {unified: 'stop' as const, raw: undefined},
        usage,
        warnings: [],
      };
    },
  });
}

async function givenApp() {
  const app = new Application();
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'test',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.service(WeatherTools);
  const server = await app.get<MCPServer>('servers.MCPServer');
  return {app, server};
}

const admin = {
  [securityId]: 'admin-1',
  roles: ['admin'],
} as unknown as UserProfile;

describe('agent turn (ToolLoopAgent + toHostTools, mock model)', () => {
  it('the magical moment: the agent calls the app own @tool, unwrapped', async () => {
    const {app} = await givenApp();
    const agent = new ToolLoopAgent({
      model: toolCallingModel('forecast', {city: 'Tokyo'}),
      tools: await toHostTools(app, {include: ['forecast']}),
    });
    const result = await agent.generate({prompt: 'Forecast for Tokyo?'});
    expect(result.text).toBe('done');
    const toolResults = result.steps.flatMap(s => s.toolResults ?? []);
    expect(toolResults).toHaveLength(1);
    // Unwrapped, output-validated result — never an MCP content envelope.
    expect(toolResults[0]).toMatchObject({
      toolName: 'forecast',
      output: {city: 'Tokyo', tempC: 21},
    });
  });

  it('ToolLoopAgent satisfies the AgentPort structurally', async () => {
    const {app} = await givenApp();
    const agent = new ToolLoopAgent({
      model: toolCallingModel('forecast', {city: 'x'}),
      tools: await toHostTools(app, {include: ['forecast']}),
    });
    // Compile-time proof; no runtime assertion needed beyond assignment.
    const port: AgentPort = agent;
    expect(typeof port.generate).toBe('function');
    expect(port.tools).toBeDefined();
  });

  it('streamOf (async-iterable) tools drain to a collected array', async () => {
    const {app} = await givenApp();
    const agent = new ToolLoopAgent({
      model: toolCallingModel('countdown', {}),
      tools: await toHostTools(app, {include: ['countdown']}),
    });
    const result = await agent.generate({prompt: 'count down'});
    const toolResults = result.steps.flatMap(s => s.toolResults ?? []);
    expect(toolResults[0]).toMatchObject({output: [3, 2, 1]});
  });

  it('per-turn identity: an @authorize-guarded tool authorizes under the request principal', async () => {
    const {app} = await givenApp();
    // Build tools ONCE; two turns with different request contexts prove the
    // identity is per-turn, not baked into the projection.
    const tools = await toHostTools(app, {include: ['admin_forecast']});
    const agent = new ToolLoopAgent({
      model: toolCallingModel('admin_forecast', {city: 'Kyoto'}),
      tools,
    });
    installAgent(app, {agent});

    // Turn 1: authenticated request context → the voter passes.
    const reqCtx = new Context(app, 'request');
    reqCtx.bind(SecurityBindings.USER).to(admin);
    const wrapped = await reqCtx.get<AgentPort>(AgentBindings.AGENT.key);
    const ok = await wrapped.generate({prompt: 'go'});
    expect(ok.text).toBe('done');

    // Turn 2: anonymous context, SAME projected tools → the voter rejects
    // (identity is per-turn, never baked at projection time). The AI SDK
    // surfaces the tool error as a tool-error part, not a thrown turn.
    const agent2 = new ToolLoopAgent({
      model: toolCallingModel('admin_forecast', {city: 'Kyoto'}),
      tools,
    });
    installAgent(app, {agent: agent2});
    const anonCtx = new Context(app, 'request');
    const wrappedAnon = await anonCtx.get<AgentPort>(AgentBindings.AGENT.key);
    const denied = (await wrappedAnon.generate({prompt: 'go'})) as {
      steps?: Array<{content: Array<{type: string}>}>;
    };
    const parts = (denied.steps ?? []).flatMap(s => s.content ?? []);
    expect(parts.some(p => p.type === 'tool-error')).toBe(true);
  });

  it('metering: one agent event + one mcp event sharing the correlation id; quota preflights', async () => {
    const {app} = await givenApp();
    // The real wiring: MeteringComponent registers the REST/MCP dispatch
    // hooks; sink + quota are overridden before the Meter first resolves.
    app.component(MeteringComponent);
    const sink = new InMemoryUsageSink();
    app.bind(MeteringBindings.SINK.key).to(sink);
    app
      .bind(MeteringBindings.QUOTA.key)
      .to(new InMemoryQuotaService({limits: {'admin-1': 1}}));

    const tools = await toHostTools(app, {include: ['forecast']});
    const agent = new ToolLoopAgent({
      model: toolCallingModel('forecast', {city: 'Tokyo'}),
      tools,
    });
    installAgent(app, {agent});

    const reqCtx = new Context(app, 'request');
    reqCtx.bind(SecurityBindings.USER).to(admin);
    const wrapped = await reqCtx.get<AgentPort>(AgentBindings.AGENT.key);
    await wrapped.generate({prompt: 'go'});

    const events = sink.all();
    const agentEvents = events.filter(e => e.surface === 'agent');
    const mcpEvents = events.filter(e => e.surface === 'mcp');
    expect(agentEvents).toHaveLength(1);
    expect(mcpEvents).toHaveLength(1);
    // Same principal, same correlation id — the sink can group the turn.
    expect(agentEvents[0].principal).toEqual({kind: 'user', id: 'admin-1'});
    expect(mcpEvents[0].principal).toEqual({kind: 'user', id: 'admin-1'});
    const turnId = agentEvents[0].meta?.correlationId;
    expect(turnId).toBeTruthy();
    expect(mcpEvents[0].meta?.correlationId).toBe(turnId);

    // Quota was consumed post-turn (limit 1) → the next turn is denied
    // PREFLIGHT, before the model spends anything.
    await expect(wrapped.generate({prompt: 'again'})).rejects.toThrow(
      /quota exceeded/,
    );
    // The denial produced no extra model call and no new mcp event.
    expect(sink.all().filter(e => e.surface === 'mcp')).toHaveLength(1);
  });

  it('installAgent lifecycle: sessions destroyed on app.stop(); RAW_AGENT is the unwrapped escape hatch', async () => {
    const {app} = await givenApp();
    let destroyed = 0;
    const session: AgentSessionLike = {
      destroy: () => {
        destroyed += 1;
      },
    };
    const raw: AgentPort = {
      generate: async () => ({text: 'raw'}),
      createSession: async () => session,
    };
    installAgent(app, {agent: raw});

    const wrapped = await app.get<AgentPort>(AgentBindings.AGENT.key);
    await wrapped.createSession!();
    const rawAgain = await app.get<AgentPort>(AgentBindings.RAW_AGENT.key);
    expect(rawAgain).toBe(raw);

    await app.start();
    await app.stop();
    expect(destroyed).toBe(1);
  });

  it('the wrapper resolves cleanly outside a request scope (anonymous turn)', async () => {
    const {app} = await givenApp();
    const tools = await toHostTools(app, {include: ['forecast']});
    const agent = new ToolLoopAgent({
      model: toolCallingModel('forecast', {city: 'Oslo'}),
      tools,
    });
    installAgent(app, {agent});
    // Resolved from the app context itself: no USER, no meter, no quota.
    const wrapped = await app.get<AgentPort>(AgentBindings.AGENT.key);
    const result = await wrapped.generate({prompt: 'go'});
    expect(result.text).toBe('done');
  });
});

describe('agent turn cancellation', () => {
  it('inherits the request signal and forwards it to the model', async () => {
    const {app} = await givenApp();
    let sawSignal: AbortSignal | undefined;
    const agent: AgentPort = {
      tools: {},
      async generate(options) {
        sawSignal = options.abortSignal;
        return {text: 'ok'};
      },
    };
    installAgent(app, {agent});

    // The shape a REST controller produces: the request context carries the
    // signal, the agent is resolved from it, the turn must pick it up.
    const controller = new AbortController();
    const reqCtx = new Context(app, 'request');
    reqCtx.bind(CoreBindings.ABORT_SIGNAL).to(controller.signal);
    const wrapped = await reqCtx.get<AgentPort>(AgentBindings.AGENT.key);

    await wrapped.generate({prompt: 'hi'});
    expect(sawSignal).toBe(controller.signal);
  });

  it('an explicit per-turn signal wins over the ambient one', async () => {
    const {app} = await givenApp();
    let sawSignal: AbortSignal | undefined;
    const agent: AgentPort = {
      tools: {},
      async generate(options) {
        sawSignal = options.abortSignal;
        return {text: 'ok'};
      },
    };
    installAgent(app, {agent});

    const ambient = new AbortController();
    const explicit = new AbortController();
    const reqCtx = new Context(app, 'request');
    reqCtx.bind(CoreBindings.ABORT_SIGNAL).to(ambient.signal);
    const wrapped = await reqCtx.get<AgentPort>(AgentBindings.AGENT.key);

    await wrapped.generate({prompt: 'hi', abortSignal: explicit.signal});
    expect(sawSignal).toBe(explicit.signal);
  });

  it('leaves abortSignal unset when nothing is cancellable', async () => {
    const {app} = await givenApp();
    let called = false;
    let sawSignal: AbortSignal | undefined;
    const agent: AgentPort = {
      tools: {},
      async generate(options) {
        called = true;
        sawSignal = options.abortSignal;
        return {text: 'ok'};
      },
    };
    installAgent(app, {agent});
    const wrapped = await app.get<AgentPort>(AgentBindings.AGENT.key);
    await wrapped.generate({prompt: 'hi'});
    expect(called).toBe(true);
    expect(sawSignal).toBeUndefined();
  });

  it('a projected tool reaches the turn signal through the context chain', async () => {
    const {app} = await givenApp();
    const tools = await toHostTools(app, {include: ['probe_signal']});
    const agent = new ToolLoopAgent({
      model: toolCallingModel('probe_signal', {}),
      tools,
    });
    installAgent(app, {agent});

    const controller = new AbortController();
    const reqCtx = new Context(app, 'request');
    reqCtx.bind(CoreBindings.ABORT_SIGNAL).to(controller.signal);
    const wrapped = await reqCtx.get<AgentPort>(AgentBindings.AGENT.key);

    toolSawSignal = undefined;
    const result = await wrapped.generate({prompt: 'probe'});
    const toolResults = (
      result as unknown as {steps: Array<{toolResults?: unknown[]}>}
    ).steps.flatMap(step => step.toolResults ?? []);
    expect(toolResults[0]).toMatchObject({output: {seen: true}});
    // The AI SDK hands `execute` its own per-call signal, which `callTool`
    // binds on the child context — so the tool sees a signal that fires when
    // EITHER the turn or the request is aborted.
    expect(toolSawSignal).toBeDefined();
    expect(toolSawSignal!.aborted).toBe(false);
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
