// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Unit tests for the console-chat bridge controller.
 *
 * All tests use an in-process ACP setup — no real subprocess is spawned.
 * A fake `AgentApp` is injected via the `CHAT_CONNECT_FN` seam.
 */

import {describe, it, expect} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {RestApplication} from '@agentback/rest';
import {
  agent as acpAgent,
  type AgentApp,
  type ClientApp,
  type ClientConnection,
  type ClientContext,
  type AgentContext,
} from '@agentclientprotocol/sdk';
import {ChatBridgeController, CHAT_CONNECT_FN} from '../../bridge.controller.js';
import type {AcpConnectFn} from '../../acp-session.js';
import type {AgentDescriptor} from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds an `AcpConnectFn` that connects a `ClientApp` directly to the given
 * `AgentApp` (in-process, no subprocess).
 */
function inProcessConnectFn(fakeAgent: AgentApp): AcpConnectFn {
  return async (
    _descriptor: AgentDescriptor,
    clientApp: ClientApp,
  ): Promise<{connection: ClientConnection; ctx: ClientContext}> => {
    const connection = clientApp.connect(fakeAgent);
    const ctx = connection.agent;
    return {connection, ctx};
  };
}

/**
 * Build a fake AgentApp that handles `initialize`, `session/new`, and
 * `session/prompt`.
 *
 * The `onPrompt` callback receives `(sessionId, promptText, agentContext)`
 * and is responsible for sending updates and returning the stop reason.
 */
function makeFakeAgent(opts: {
  onPrompt?: (
    sessionId: string,
    text: string,
    ctx: AgentContext,
  ) => Promise<'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal'>;
} = {}): AgentApp {
  const app = acpAgent({name: 'fake-agent'});

  app.onRequest('initialize', async () => ({
    protocolVersion: 1 as const,
    agentCapabilities: {},
  }));

  app.onRequest('session/new', async () => ({
    sessionId: `fake-session-${Date.now()}`,
    _meta: null,
  }));

  app.onRequest('session/prompt', async ({params, client}) => {
    const sessionId = params.sessionId;
    const firstBlock = params.prompt[0] as {type: string; text?: string} | undefined;
    const text = firstBlock?.type === 'text' ? (firstBlock.text ?? '') : '';

    let stopReason: 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal';
    if (opts.onPrompt) {
      stopReason = await opts.onPrompt(sessionId, text, client);
    } else {
      // Default: emit one chunk then stop.
      // ACP SessionUpdate uses `sessionUpdate` discriminant; ContentChunk.content is a single ContentBlock.
      await client.notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {type: 'text', text: `echo: ${text}`},
        } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
      });
      stopReason = 'end_turn';
    }
    return {stopReason, _meta: null};
  });

  return app;
}

/**
 * Build a minimal test application with the ChatBridgeController and the
 * injected connect function.
 */
function makeApp(connectFn: AcpConnectFn): RestApplication {
  const app = new RestApplication({rest: {port: 0}});
  app.restController(ChatBridgeController);
  app.bind(CHAT_CONNECT_FN.key).to(connectFn);
  return app;
}

// ---------------------------------------------------------------------------
// 1. AcpSession unit: connect + open + prompt + stop
// ---------------------------------------------------------------------------

describe('AcpSession connect + prompt flow', () => {
  it('opens a session and receives text chunks then stop', async () => {
    const fakeAgent = makeFakeAgent({
      onPrompt: async (sessionId, _text, ctx) => {
        // ACP SessionUpdate: use `sessionUpdate` discriminant, content is singular ContentBlock.
        await ctx.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {type: 'text', text: 'Hello '},
          } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
        });
        await ctx.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {type: 'text', text: 'world'},
          } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
        });
        return 'end_turn';
      },
    });

    const connectFn = inProcessConnectFn(fakeAgent);
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };

    const {AcpSession} = await import('../../acp-session.js');
    const session = new AcpSession(descriptor, connectFn);
    await session.connect();
    const sessionId = await session.open([], process.cwd());
    expect(typeof sessionId).toBe('string');

    const events: import('../../acp-session.js').AcpEvent[] = [];
    session.on('event', ev => events.push(ev));

    // Wait for stop event.
    const stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      session.on('event', ev => {
        if (ev.type === 'stop' || ev.type === 'error') {
          clearTimeout(timer);
          if (ev.type === 'error') reject((ev as {error: unknown}).error as Error);
          else resolve();
        }
      });
    });

    await session.prompt('Hi');
    await stopPromise;

    const deltas = events.filter(e => e.type === 'assistant_delta');
    expect(deltas.length).toBeGreaterThan(0);

    const texts = deltas.map(e => (e as import('../../acp-session.js').AssistantDeltaEvent).text);
    expect(texts.join('')).toBe('Hello world');

    const stop = events.find(e => e.type === 'stop');
    expect(stop).toBeDefined();
    expect((stop as import('../../acp-session.js').StopEvent).stopReason).toBe('end_turn');

    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. Permission request flow
// ---------------------------------------------------------------------------

describe('permission request', () => {
  it('emits permission_request event, resolves it, and completes the turn', async () => {
    const permAgent = acpAgent({name: 'perm-agent'});
    permAgent.onRequest('initialize', async () => ({
      protocolVersion: 1 as const,
      agentCapabilities: {},
    }));
    permAgent.onRequest('session/new', async () => ({
      sessionId: `perm-session-${Date.now()}`,
      _meta: null,
    }));
    permAgent.onRequest('session/prompt', async ({params, client}) => {
      const sid = params.sessionId;
      // Request permission from the client.
      await client.request('session/request_permission', {
        sessionId: sid,
        toolCall: {toolCallId: 'tc-1', kind: 'execute', title: 'Run script'},
        options: [
          {optionId: 'allow_once', kind: 'allow_once', name: 'Allow once'},
          {optionId: 'reject_once', kind: 'reject_once', name: 'Reject once'},
        ],
      });
      // After permission granted, send a text chunk.
      await client.notify('session/update', {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {type: 'text', text: 'authorized'},
        } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
      });
      return {stopReason: 'end_turn' as const, _meta: null};
    });

    const connectFn = inProcessConnectFn(permAgent);
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };

    const {AcpSession} = await import('../../acp-session.js');
    const session = new AcpSession(descriptor, connectFn);
    await session.connect();
    await session.open([], process.cwd());

    const events: import('../../acp-session.js').AcpEvent[] = [];
    session.on('event', ev => events.push(ev));

    // Wait for permission_request event.
    const permPromise = new Promise<import('../../acp-session.js').PermissionRequestEvent>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for permission_request')), 3000);
        const check = (): void => {
          const ev = events.find(e => e.type === 'permission_request');
          if (ev) {
            clearTimeout(timer);
            resolve(ev as import('../../acp-session.js').PermissionRequestEvent);
          }
        };
        session.on('event', check);
        check();
      },
    );

    // Wait for stop event.
    const stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for stop')), 5000);
      session.on('event', ev => {
        if (ev.type === 'stop') {
          clearTimeout(timer);
          resolve();
        }
        if (ev.type === 'error') {
          clearTimeout(timer);
          reject((ev as {error: unknown}).error as Error);
        }
      });
    });

    // Send the prompt to kick off the turn.
    await session.prompt('do something');

    // Wait for the permission request.
    const permEvent = await permPromise;
    expect(permEvent.requestId).toBeTruthy();
    expect(permEvent.options.length).toBe(2);

    // Resolve the permission.
    session.resolvePermission(permEvent.requestId, 'allow_once');

    // Wait for turn completion.
    await stopPromise;

    const deltas = events.filter(e => e.type === 'assistant_delta');
    expect(deltas.length).toBeGreaterThan(0);
    const text = deltas.map(e => (e as import('../../acp-session.js').AssistantDeltaEvent).text).join('');
    expect(text).toBe('authorized');

    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP controller: GET /agents
// ---------------------------------------------------------------------------

describe('GET /console/chat/agents', () => {
  it('returns an array of agents', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    await using t = await createTestApp(makeApp.bind(null, connectFn));

    const res = await t.http.get('/console/chat/agents');
    // May return 200 with an empty or populated agents array.
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as {agents: unknown}).agents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Session dispose idempotence
// ---------------------------------------------------------------------------

describe('AcpSession lifecycle', () => {
  it('dispose is idempotent', async () => {
    const fakeAgent = makeFakeAgent();
    const connectFn = inProcessConnectFn(fakeAgent);
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };
    const {AcpSession} = await import('../../acp-session.js');
    const session = new AcpSession(descriptor, connectFn);
    await session.connect();
    await session.open([], process.cwd());

    session.dispose();
    session.dispose(); // Should not throw.
    expect(true).toBe(true);
  });

  it('calling prompt after dispose throws', async () => {
    const fakeAgent = makeFakeAgent();
    const connectFn = inProcessConnectFn(fakeAgent);
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };
    const {AcpSession} = await import('../../acp-session.js');
    const session = new AcpSession(descriptor, connectFn);
    await session.connect();
    await session.open([], process.cwd());
    session.dispose();

    await expect(session.prompt('test')).rejects.toThrow('disposed');
  });

  it('calling open before connect throws', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };
    const {AcpSession} = await import('../../acp-session.js');
    const session = new AcpSession(descriptor, connectFn);

    await expect(session.open([], process.cwd())).rejects.toThrow('connect()');
  });
});

// ---------------------------------------------------------------------------
// 5. HTTP controller: DELETE /session idempotence
// ---------------------------------------------------------------------------

describe('DELETE /console/chat/session', () => {
  it('returns 200 for an unknown session (idempotent)', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    await using t = await createTestApp(makeApp.bind(null, connectFn));

    const res = await t.http
      .delete('/console/chat/session')
      .send({sessionId: 'nonexistent-session-id'});

    expect(res.status).toBe(200);
  });
});
