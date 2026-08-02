// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {RestApplication, type RestServer} from '@agentback/rest';
import {AgentBindings, type AgentPort} from '@agentback/agents';
import {agentsConsoleFeature} from '../../feature.js';
import {AgentPlaygroundController} from '../../turn.controller.js';

// The playground's whole job is to route a browser prompt through the app's
// REAL agent binding, server-side. So these drive the HTTP surface with a stub
// agent rather than calling the controller directly — the wiring (feature gate,
// binding resolution, envelope shape) is the part that can break.

/**
 * A REST response body. Success is the handler's return value VERBATIM — there
 * is no `{data: …}` wrapper; only failures are enveloped, under `error`.
 */
interface Envelope {
  text?: string;
  steps?: unknown[];
  available?: boolean;
  tools?: string[];
  error?: {message?: string; code?: string; retryable?: boolean};
  [k: string]: unknown;
}

/**
 * Read a response body defensively. A route that was never mounted answers with
 * Express's HTML 404 page, not JSON — the disabled-feature test depends on
 * telling those apart rather than throwing a parse error.
 */
async function readBody(res: Response): Promise<Envelope> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Envelope;
  } catch {
    return {nonJson: text.slice(0, 40)};
  }
}

/** A stub standing in for an AI SDK agent; records what it was asked. */
function stubAgent(
  over: Partial<AgentPort> = {},
): AgentPort & {seen: string[]} {
  const seen: string[] = [];
  return {
    seen,
    tools: {forecast: {}, echo: {}},
    async generate(options: {prompt?: unknown}) {
      seen.push(String(options.prompt));
      return {
        text: 'It is 21°C in Tokyo.',
        steps: [
          {
            text: 'Let me check.',
            toolCalls: [{toolName: 'forecast', input: {city: 'Tokyo'}}],
            toolResults: [{toolName: 'forecast', output: {tempC: 21}}],
          },
        ],
      };
    },
    ...over,
  } as AgentPort & {seen: string[]};
}

async function start(opts: {enabled?: boolean; agent?: AgentPort} = {}) {
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
  if (opts.agent) app.bind(AgentBindings.AGENT.key).to(opts.agent);
  const feature = agentsConsoleFeature({enabled: opts.enabled ?? true});
  await feature.install(app);
  await app.start();
  const url = (await app.get<RestServer>('servers.RestServer')).url;
  return {
    app,
    feature,
    async post(body: unknown) {
      const res = await fetch(`${url}/console/agents/api/turn`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
      });
      return {status: res.status, body: await readBody(res)};
    },
    async status() {
      const res = await fetch(`${url}/console/agents/api/status`);
      return {status: res.status, body: await readBody(res)};
    },
  };
}

describe('agent playground', () => {
  it('runs a turn through the bound agent and flattens the steps', async () => {
    const agent = stubAgent();
    const t = await start({agent});
    try {
      const {status, body} = await t.post({prompt: 'weather in Tokyo?'});
      expect(status).toBe(200);
      const data = body as {text: string; steps: Record<string, never>[]};
      expect(data.text).toContain('21°C');
      // The prompt reached the real agent, not a parallel path.
      expect(agent.seen).toEqual(['weather in Tokyo?']);
      // Steps are flattened to what the panel renders — tool name in, out.
      expect(data.steps).toHaveLength(1);
      const step = data.steps[0] as unknown as {
        toolCalls: {toolName: string; input: unknown}[];
        toolResults: {toolName: string; output: unknown}[];
      };
      expect(step.toolCalls[0]).toMatchObject({
        toolName: 'forecast',
        input: {city: 'Tokyo'},
      });
      expect(step.toolResults[0].output).toEqual({tempC: 21});
    } finally {
      await t.app.stop();
    }
  });

  it('reports availability and the tool names for the empty state', async () => {
    const t = await start({agent: stubAgent()});
    try {
      const {body} = await t.status();
      expect(body).toEqual({available: true, tools: ['echo', 'forecast']});
    } finally {
      await t.app.stop();
    }
  });

  it('says so plainly when no agent is bound, instead of failing obscurely', async () => {
    // The page is statically bundled into the console, so it is always
    // reachable. Without an agent it must explain itself rather than 500.
    const t = await start({});
    try {
      const s = await t.status();
      expect(s.body.available).toBe(false);

      const {status, body} = await t.post({prompt: 'hi'});
      expect(status).toBe(404);
      // An AgentError, so the message survives redaction and reaches the panel.
      expect(body.error?.message).toContain('installAgent');
      expect(body.error?.retryable).toBe(false);
    } finally {
      await t.app.stop();
    }
  });

  it('mounts nothing at all when the feature is disabled', async () => {
    // Off by default because a turn spends tokens and invokes real tools. The
    // route must be absent, not merely hidden in the UI.
    const t = await start({enabled: false, agent: stubAgent()});
    try {
      const {status} = await t.post({prompt: 'hi'});
      expect(status).toBe(404);
      expect(t.feature.extra).toEqual({enabled: false});
    } finally {
      await t.app.stop();
    }
  });

  it('validates the prompt rather than forwarding junk to the model', async () => {
    const agent = stubAgent();
    const t = await start({agent});
    try {
      // 422, not 400: the framework maps a body-schema failure to
      // `invalid_body`. Asserting the real code keeps this honest about the
      // contract the panel actually has to handle.
      expect((await t.post({prompt: ''})).status).toBe(422);
      expect((await t.post({})).status).toBe(422);
      expect((await t.post({prompt: 'x'.repeat(8001)})).status).toBe(422);
      // Nothing reached the model — each rejection is free.
      expect(agent.seen).toEqual([]);
    } finally {
      await t.app.stop();
    }
  });

  it('survives an agent that returns no steps', async () => {
    // A single-shot model with no tool calls is normal, not an error.
    const t = await start({
      agent: stubAgent({
        async generate() {
          return {text: 'plain answer'};
        },
      }),
    });
    try {
      const {status, body} = await t.post({prompt: 'hi'});
      expect(status).toBe(200);
      expect(body.steps).toEqual([]);
    } finally {
      await t.app.stop();
    }
  });
});

describe('feature shape', () => {
  it('is a ConsoleFeature the console shell can consume', () => {
    const f = agentsConsoleFeature({enabled: true});
    expect(f.id).toBe('agents');
    expect(f.apiBase).toBe('/console/agents/api');
    expect(typeof f.install).toBe('function');
  });

  it('registers the controller only when enabled', async () => {
    const app = new RestApplication({});
    const before = app.find('controllers.*').length;
    agentsConsoleFeature({}).install(app);
    expect(app.find('controllers.*').length).toBe(before);
    agentsConsoleFeature({enabled: true}).install(app);
    expect(app.find('controllers.*').length).toBe(before + 1);
    expect(
      app.find('controllers.*').some(b => b.key.includes('AgentPlayground')),
    ).toBe(true);
    void AgentPlaygroundController;
  });
});
