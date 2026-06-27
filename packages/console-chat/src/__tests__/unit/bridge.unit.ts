// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Unit tests for the console-chat bridge controller.
 *
 * All tests use an in-process ACP setup — no real subprocess is spawned.
 * A fake `AgentApp` is injected via the `CHAT_CONNECT_FN` seam.
 */

import http from 'node:http';
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
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
import {
  ChatBridgeController,
  CHAT_CONNECT_FN,
  CHAT_DISCOVER,
  CHAT_WORKSPACE_ROOT,
} from '../../bridge.controller.js';
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
  ): Promise<{
    connection: ClientConnection;
    ctx: ClientContext;
    kill: () => void;
  }> => {
    const connection = clientApp.connect(fakeAgent);
    const ctx = connection.agent;
    // In-process connections have no subprocess to kill.
    const kill = () => {};
    return {connection, ctx, kill};
  };
}

/**
 * Build a fake AgentApp that handles `initialize`, `session/new`, and
 * `session/prompt`.
 *
 * The `onPrompt` callback receives `(sessionId, promptText, agentContext)`
 * and is responsible for sending updates and returning the stop reason.
 */
function makeFakeAgent(
  opts: {
    onPrompt?: (
      sessionId: string,
      text: string,
      ctx: AgentContext,
    ) => Promise<
      'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal'
    >;
  } = {},
): AgentApp {
  const app = acpAgent({name: 'fake-agent'});

  app.onRequest('initialize', async () => ({
    protocolVersion: 1 as const,
    agentCapabilities: {},
  }));

  app.onRequest('session/new', async () => ({
    sessionId: `fake-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    _meta: null,
  }));

  app.onRequest('session/prompt', async ({params, client}) => {
    const sessionId = params.sessionId;
    const firstBlock = params.prompt[0] as
      | {type: string; text?: string}
      | undefined;
    const text = firstBlock?.type === 'text' ? (firstBlock.text ?? '') : '';

    let stopReason:
      | 'end_turn'
      | 'cancelled'
      | 'max_tokens'
      | 'max_turn_requests'
      | 'refusal';
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
 *
 * When `principalId` is provided, a middleware is installed that sets
 * `req.auth` to `{token: 'test', clientId: principalId, scopes: []}` on
 * every request — matching the AuthInfo shape that `principalFromRequest`
 * reads. Passing `undefined` leaves `req.auth` unset, so bridge endpoints
 * return 401 (tests the unauthenticated path).
 */
function makeApp(
  connectFn: AcpConnectFn,
  principalId?: string,
): RestApplication {
  const app = new RestApplication({rest: {port: 0}});
  app.restController(ChatBridgeController);
  app.bind(CHAT_CONNECT_FN.key).to(connectFn);
  if (principalId) {
    // Install a test auth middleware that sets req.auth to the given principal.
    // Uses the key+handler overload of expressMiddleware.
    app.expressMiddleware(
      'middleware.test.auth',
      (
        req: import('express').Request,
        _res: import('express').Response,
        next: import('express').NextFunction,
      ) => {
        (
          req as import('express').Request & {
            auth?: {token: string; clientId: string; scopes: string[]};
          }
        ).auth = {
          token: 'test',
          clientId: principalId,
          scopes: [],
        };
        next();
      },
    );
  }
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
          if (ev.type === 'error')
            reject((ev as {error: unknown}).error as Error);
          else resolve();
        }
      });
    });

    await session.prompt('Hi');
    await stopPromise;

    const deltas = events.filter(e => e.type === 'assistant_delta');
    expect(deltas.length).toBeGreaterThan(0);

    const texts = deltas.map(
      e => (e as import('../../acp-session.js').AssistantDeltaEvent).text,
    );
    expect(texts.join('')).toBe('Hello world');

    const stop = events.find(e => e.type === 'stop');
    expect(stop).toBeDefined();
    expect((stop as import('../../acp-session.js').StopEvent).stopReason).toBe(
      'end_turn',
    );

    session.dispose();
  });

  it('forwards tool_call_update so a tool call resolves out of pending', async () => {
    // ACP emits `tool_call` (pending) then `tool_call_update` (completed) on the
    // same toolCallId. The bridge must forward BOTH or the tool block stays
    // "pending" at the bottom forever.
    const fakeAgent = makeFakeAgent({
      onPrompt: async (sessionId, _text, ctx) => {
        // ACP `tool_call` is FLAT (ToolCall fields directly on the update),
        // not nested under a `toolCall` key.
        await ctx.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc1',
            title: 'inventory',
            status: 'pending',
          } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
        });
        await ctx.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc1',
            status: 'completed',
          } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
        });
        return 'end_turn';
      },
    });

    const {AcpSession} = await import('../../acp-session.js');
    const session = new AcpSession(
      {id: 'test', name: 'Test', detect: {bin: 'test'}, command: ['test']},
      inProcessConnectFn(fakeAgent),
    );
    await session.connect();
    await session.open([], process.cwd());

    const tools: import('../../acp-session.js').ToolCallEvent[] = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      session.on('event', ev => {
        if (ev.type === 'tool_call') {
          tools.push(ev as import('../../acp-session.js').ToolCallEvent);
        } else if (ev.type === 'stop' || ev.type === 'error') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await session.prompt('go');
    await done;

    // Both the initial call and the update were forwarded for the same id,
    // and the final status is 'completed' (not stuck at 'pending').
    const tc1 = tools.filter(t => t.toolCallId === 'tc1');
    expect(tc1.length).toBe(2);
    expect(tc1[tc1.length - 1]!.status).toBe('completed');

    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// 1b. Permission-mode enforcement: open() sets 'default' mode when the agent
//     advertises modes with currentModeId !== 'default'
// ---------------------------------------------------------------------------

describe('Permission-mode enforcement: open() forces prompting mode', () => {
  it('sends session/set_mode with default when agent advertises acceptEdits', async () => {
    const setModeCalls: Array<{sessionId: string; modeId: string}> = [];

    const modeAgent = acpAgent({name: 'mode-agent'});
    modeAgent.onRequest('initialize', async () => ({
      protocolVersion: 1 as const,
      agentCapabilities: {},
    }));
    modeAgent.onRequest('session/new', async () => ({
      sessionId: `mode-session-${Date.now()}`,
      modes: {
        currentModeId: 'acceptEdits',
        availableModes: [
          {id: 'default', name: 'Default (prompting)'},
          {id: 'acceptEdits', name: 'Accept Edits'},
        ],
      },
      _meta: null,
    }));
    // Record set_mode calls from the client.
    modeAgent.onRequest('session/set_mode', async ({params}) => {
      setModeCalls.push({sessionId: params.sessionId, modeId: params.modeId});
      return {_meta: null};
    });
    modeAgent.onRequest('session/prompt', async () => ({
      stopReason: 'end_turn' as const,
      _meta: null,
    }));

    const connectFn = inProcessConnectFn(modeAgent);
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
    // The fake agent should have received exactly one set_mode call.
    expect(setModeCalls.length).toBe(1);
    expect(setModeCalls[0].modeId).toBe('default');
    expect(setModeCalls[0].sessionId).toBe(sessionId);

    session.dispose();
  });

  it('does not send session/set_mode when agent advertises no modes (no throw)', async () => {
    const setModeCalls: Array<unknown> = [];

    const noModeAgent = acpAgent({name: 'no-mode-agent'});
    noModeAgent.onRequest('initialize', async () => ({
      protocolVersion: 1 as const,
      agentCapabilities: {},
    }));
    noModeAgent.onRequest('session/new', async () => ({
      // No modes field — simulates an agent that does not advertise session modes.
      sessionId: `no-mode-session-${Date.now()}`,
      _meta: null,
    }));
    noModeAgent.onRequest('session/set_mode', async ({params}) => {
      setModeCalls.push(params);
      return {_meta: null};
    });
    noModeAgent.onRequest('session/prompt', async () => ({
      stopReason: 'end_turn' as const,
      _meta: null,
    }));

    const connectFn = inProcessConnectFn(noModeAgent);
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };

    const {AcpSession} = await import('../../acp-session.js');
    const session = new AcpSession(descriptor, connectFn);
    await session.connect();

    // open() must succeed even when no modes are advertised — it logs a warning
    // and proceeds without throwing.
    const sessionId = await session.open([], process.cwd());
    expect(typeof sessionId).toBe('string');

    // No set_mode should have been sent.
    expect(setModeCalls.length).toBe(0);

    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// 1c. I2: user_message_chunk must NOT be echoed as assistant_delta
// ---------------------------------------------------------------------------

describe('I2: user_message_chunk not echoed as assistant_delta', () => {
  it('does not emit assistant_delta for user_message_chunk', async () => {
    const fakeAgent = makeFakeAgent({
      onPrompt: async (sessionId, _text, ctx) => {
        // Send a user_message_chunk first (should NOT produce assistant_delta).
        await ctx.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'user_message_chunk',
            content: {type: 'text', text: 'user input echo'},
          } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
        });
        // Then a real agent chunk.
        await ctx.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {type: 'text', text: 'agent reply'},
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
    await session.open([], process.cwd());

    const events: import('../../acp-session.js').AcpEvent[] = [];
    session.on('event', ev => events.push(ev));

    const stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
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

    await session.prompt('Hi');
    await stopPromise;

    const deltas = events.filter(e => e.type === 'assistant_delta');
    expect(deltas.length).toBe(1);
    expect(
      (deltas[0] as import('../../acp-session.js').AssistantDeltaEvent).text,
    ).toBe('agent reply');

    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// 1c. I-3: orientation/grounding turn is drained quietly — its reply does NOT
//     bleed into the first user turn, and no spurious early stop is emitted.
// ---------------------------------------------------------------------------

describe('I-3: grounding turn drained quietly, first user turn streams clean', () => {
  it('does not leak the orientation reply or a spurious stop into the user turn', async () => {
    // The fake agent REPLIES to the orientation prompt (assistant chunk + stop)
    // and replies differently to the user prompt.  It distinguishes the two by
    // the `<system-context>` marker injectContext() wraps the brief in.
    const fakeAgent = makeFakeAgent({
      onPrompt: async (sessionId, text, ctx) => {
        const isOrientation = text.includes('<system-context>');
        if (isOrientation) {
          // Orientation turn: emit chunks the user turn must NOT see.
          await ctx.notify('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'ORIENTATION_REPLY: got it, understood the schema.',
              },
            } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
          });
          return 'end_turn';
        }
        // User turn: distinct content.
        await ctx.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {type: 'text', text: 'USER_REPLY: hello there'},
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
    await session.open([], process.cwd());

    // Inject the orientation brief — this fires the quiet grounding drain.
    await session.injectContext(
      'REST routes / MCP tools / domain entities go here.',
    );

    // Only collect events AFTER the user prompt begins.  Any orientation chunk
    // or a premature stop reaching this collector would prove the bug.
    const userEvents: import('../../acp-session.js').AcpEvent[] = [];
    session.on('event', ev => userEvents.push(ev));

    const stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for user turn stop')),
        3000,
      );
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

    await session.prompt('Hi there');
    await stopPromise;

    const deltas = userEvents.filter(e => e.type === 'assistant_delta');
    const texts = deltas.map(
      e => (e as import('../../acp-session.js').AssistantDeltaEvent).text,
    );

    // The orientation reply must NOT appear in the user turn's stream.
    expect(texts.join('')).not.toContain('ORIENTATION_REPLY');
    // The user turn's own content streams cleanly.
    expect(texts.join('')).toBe('USER_REPLY: hello there');

    // Exactly ONE stop event — the user turn's own.  A leaked orientation
    // `stop` (the bug) would surface a second, premature stop here.
    const stops = userEvents.filter(e => e.type === 'stop');
    expect(stops.length).toBe(1);

    // And the very first delta must be the user reply, not the orientation
    // leftover — i.e. nothing bled in ahead of the user turn's content.
    expect(deltas.length).toBe(1);
    expect(
      (deltas[0] as import('../../acp-session.js').AssistantDeltaEvent).text,
    ).toBe('USER_REPLY: hello there');

    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// 2. Permission request flow
// ---------------------------------------------------------------------------

describe('permission request', () => {
  it('emits permission_request event with label, resolves it, and completes the turn', async () => {
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
    const permPromise = new Promise<
      import('../../acp-session.js').PermissionRequestEvent
    >((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for permission_request')),
        3000,
      );
      const check = (): void => {
        const ev = events.find(e => e.type === 'permission_request');
        if (ev) {
          clearTimeout(timer);
          resolve(ev as import('../../acp-session.js').PermissionRequestEvent);
        }
      };
      session.on('event', check);
      check();
    });

    // Wait for stop event.
    const stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for stop')),
        5000,
      );
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
    // m5: label must be preserved
    expect(permEvent.options[0].label).toBe('Allow once');
    expect(permEvent.options[1].label).toBe('Reject once');

    // Resolve the permission.
    session.resolvePermission(permEvent.requestId, 'allow_once');

    // Wait for turn completion.
    await stopPromise;

    const deltas = events.filter(e => e.type === 'assistant_delta');
    expect(deltas.length).toBeGreaterThan(0);
    const text = deltas
      .map(e => (e as import('../../acp-session.js').AssistantDeltaEvent).text)
      .join('');
    expect(text).toBe('authorized');

    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP controller: GET /agents (no auth needed)
// ---------------------------------------------------------------------------

describe('GET /console/chat/agents', () => {
  it('returns an array of agents', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    await using t = await createTestApp(
      makeApp.bind(null, connectFn, undefined),
    );

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
    await using t = await createTestApp(makeApp.bind(null, connectFn, 'user1'));

    const res = await t.http
      .delete('/console/chat/session')
      .send({sessionId: 'nonexistent-session-id'});

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 6. Security: unauthenticated requests are rejected
// ---------------------------------------------------------------------------

describe('Security: authentication required', () => {
  it('POST /session without user returns 401', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    // No user bound.
    await using t = await createTestApp(
      makeApp.bind(null, connectFn, undefined),
    );

    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude'});

    expect(res.status).toBe(401);
  });

  it('POST /message without user returns 401', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    await using t = await createTestApp(
      makeApp.bind(null, connectFn, undefined),
    );

    const res = await t.http
      .post('/console/chat/message')
      .send({sessionId: 'fake', text: 'hello'});

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 7. Two-principal isolation: principal A cannot access principal B's session
// ---------------------------------------------------------------------------

describe('Two-principal session isolation', () => {
  it('principal B cannot read/drive/delete principal A session', async () => {
    const fakeAgent = makeFakeAgent();

    // Build an app authenticated as alice to create the session.
    const connectFn = inProcessConnectFn(fakeAgent);
    await using tA = await createTestApp(
      makeApp.bind(null, connectFn, 'alice'),
    );

    // Create a session as alice. Use claude-code which is in BUILTIN_AGENTS.
    const createRes = await tA.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: process.cwd()});
    expect(createRes.status).toBe(200);
    const sessionId = (createRes.body as {sessionId: string}).sessionId;
    expect(typeof sessionId).toBe('string');

    // Build a second app authenticated as bob. It has its own separate sessions
    // map (separate controller instance), so alice's session does not exist there.
    await using tB = await createTestApp(makeApp.bind(null, connectFn, 'bob'));

    // bob tries to send a message to alice's session → 404 (not found for bob's principal).
    const msgRes = await tB.http
      .post('/console/chat/message')
      .send({sessionId, text: 'attack'});
    expect(msgRes.status).toBe(404);

    // bob tries to delete alice's session → 200 (idempotent; nothing to delete for bob).
    const delRes = await tB.http
      .delete('/console/chat/session')
      .send({sessionId});
    expect(delRes.status).toBe(200);

    // alice can still send a message (session is intact in alice's controller).
    const aMsg = await tA.http
      .post('/console/chat/message')
      .send({sessionId, text: 'hello from alice'});
    expect(aMsg.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 8. SSE stream: connection stays open and events are delivered (C2 test)
//
// We use `handleSseRequest` directly (not through the full Express mount)
// to test that the SSE handler keeps the connection alive and forwards events.
// ---------------------------------------------------------------------------

describe('SSE stream: C2 — stream stays open and delivers events', () => {
  it('sends an assistant_delta SSE frame to a connected client', async () => {
    const {handleSseRequest} = await import('../../bridge.controller.js');
    const {AcpSession} = await import('../../acp-session.js');

    const fakeAgent = makeFakeAgent({
      onPrompt: async (sessionId, _text, ctx) => {
        await ctx.notify('session/update', {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {type: 'text', text: 'streamed reply'},
          } as unknown as import('@agentclientprotocol/sdk').SessionUpdate,
        });
        return 'end_turn';
      },
    });

    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };
    const session = new AcpSession(descriptor, inProcessConnectFn(fakeAgent));
    await session.connect();
    const acpSessionId = await session.open([], process.cwd());
    const principal = 'sse-test-principal';

    const sessions = new Map<
      string,
      {
        session: typeof session;
        acpSessionId: string;
        sseDisconnectedAt: number | null;
      }
    >();
    sessions.set(`${principal}:${acpSessionId}`, {
      session,
      acpSessionId,
      sseDisconnectedAt: null,
    });

    const rawServer = http.createServer((req, res) => {
      handleSseRequest(
        sessions as Parameters<typeof handleSseRequest>[0],
        principal,
        acpSessionId,
        req as unknown as import('express').Request,
        res as unknown as import('express').Response,
      );
    });

    await new Promise<void>(resolve =>
      rawServer.listen(0, '127.0.0.1', resolve),
    );
    const port = (rawServer.address() as {port: number}).port;

    const frames: string[] = [];
    let finished = false;

    // Phase 1: establish the SSE connection and wait for the headers so we
    // know the server has attached the event listener before we prompt.
    await new Promise<void>((resolve, reject) => {
      const clientReq = http.get(
        `http://127.0.0.1:${port}/?sessionId=${acpSessionId}`,
        res => {
          expect(res.headers['content-type']).toMatch(/text\/event-stream/);
          // Headers received = handleSseRequest has run and the listener is attached.
          resolve();

          // Phase 2: collect data frames (runs concurrently after resolve).
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                frames.push(line.slice(6));
                const parsed = JSON.parse(line.slice(6)) as {type: string};
                if (parsed.type === 'stop') {
                  finished = true;
                  clientReq.destroy();
                }
              }
            }
          });
          res.on('error', () => {
            /* post-destroy cleanup */
          });
        },
      );
      clientReq.on('error', (e: Error) => {
        if (finished) return;
        reject(e);
      });
      clientReq.setTimeout(5000, () => {
        clientReq.destroy();
        reject(new Error('SSE connect timed out'));
      });
    });

    // Phase 3: prompt AFTER the SSE listener is attached.
    await session.prompt('hello');

    // Wait for the stop event to arrive (data listeners are still active).
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('SSE stop frame timed out')),
        5000,
      );
      const check = () => {
        if (
          frames.some(f => {
            try {
              return (JSON.parse(f) as {type: string}).type === 'stop';
            } catch {
              return false;
            }
          })
        ) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    const parsedFrames = frames.map(
      f => JSON.parse(f) as {type: string; text?: string},
    );
    const delta = parsedFrames.find(f => f.type === 'assistant_delta');
    expect(delta).toBeDefined();
    expect(delta?.text).toBe('streamed reply');
    expect(parsedFrames.find(f => f.type === 'stop')).toBeDefined();

    rawServer.close();
    session.dispose();
  }, 15000);
});

// ---------------------------------------------------------------------------
// 9. Lease GC: SSE disconnect sets sseDisconnectedAt; session survives lease
// ---------------------------------------------------------------------------

describe('Lease GC: SSE disconnect triggers session GC after lease', () => {
  it('session is still alive within lease window after SSE disconnect', async () => {
    // Verifies: sseDisconnectedAt is set on disconnect; the session is NOT
    // immediately removed (it survives the lease window for reconnects).

    const {AcpSession} = await import('../../acp-session.js');
    const {handleSseRequest} = await import('../../bridge.controller.js');

    const fakeAgent = makeFakeAgent();
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };
    const session = new AcpSession(descriptor, inProcessConnectFn(fakeAgent));
    await session.connect();
    const acpSessionId = await session.open([], process.cwd());
    const principal = 'lease-principal';

    const sessions = new Map<
      string,
      {
        session: typeof session;
        acpSessionId: string;
        sseDisconnectedAt: number | null;
      }
    >();
    sessions.set(`${principal}:${acpSessionId}`, {
      session,
      acpSessionId,
      sseDisconnectedAt: null,
    });

    const rawServer = http.createServer((req, res) => {
      handleSseRequest(
        sessions as Parameters<typeof handleSseRequest>[0],
        principal,
        acpSessionId,
        req as unknown as import('express').Request,
        res as unknown as import('express').Response,
      );
    });

    await new Promise<void>(resolve =>
      rawServer.listen(0, '127.0.0.1', resolve),
    );
    const port = (rawServer.address() as {port: number}).port;

    // Connect, wait for the SSE response headers (the callback firing = headers
    // received = handleSseRequest has run and attached the event listener),
    // then immediately destroy the connection to simulate a client disconnect.
    let destroyed = false;
    await new Promise<void>((resolve, reject) => {
      const clientReq = http.get(
        `http://127.0.0.1:${port}/?sessionId=${acpSessionId}`,
        res => {
          // The callback fires when headers arrive (HTTP/1.1 response line +
          // headers have been received).  At this point handleSseRequest has
          // already called flushHeaders() and the 'close' listener is wired.
          expect(res.statusCode).toBe(200);
          // Destroy immediately to trigger the server-side 'close' event.
          destroyed = true;
          clientReq.destroy();
          // Allow the 'close' event to propagate through the server-side socket.
          setTimeout(resolve, 100);
          res.on('error', () => {
            /* ignore post-destroy */
          });
        },
      );
      clientReq.on('error', (e: Error) => {
        if (destroyed) return; // Expected — we destroyed the socket.
        reject(e);
      });
      clientReq.setTimeout(3000, () => {
        clientReq.destroy();
        reject(new Error('lease test: SSE connect timed out'));
      });
    });

    // Session should still be in the map (lease window has not elapsed).
    expect(sessions.has(`${principal}:${acpSessionId}`)).toBe(true);
    const entry = sessions.get(`${principal}:${acpSessionId}`);
    // sseDisconnectedAt must be set — proves the close handler ran.
    expect(entry?.sseDisconnectedAt).not.toBeNull();

    rawServer.close();
    session.dispose();
  }, 10000);
});

// ---------------------------------------------------------------------------
// 10. Grounding: createSession injects the app's own mcp-http URL
//     when no mcpServers are provided by the caller.
// ---------------------------------------------------------------------------

describe('Grounding: session/new receives mcpServers for the app mcp-http', () => {
  it('open() is called with an mcpServers entry pointing at the app mcp-http URL', async () => {
    // The test inspects the mcpServers passed to session/new via the fake agent.
    let capturedMcpServers: unknown[] | undefined;

    const groundingAgent = acpAgent({name: 'grounding-agent'});
    groundingAgent.onRequest('initialize', async () => ({
      protocolVersion: 1 as const,
      agentCapabilities: {},
    }));
    groundingAgent.onRequest('session/new', async ({params}) => {
      capturedMcpServers =
        (params as {mcpServers?: unknown[]}).mcpServers ?? [];
      return {
        sessionId: `grounding-session-${Date.now()}`,
        _meta: null,
      };
    });
    groundingAgent.onRequest('session/prompt', async () => ({
      stopReason: 'end_turn' as const,
      _meta: null,
    }));

    const connectFn = inProcessConnectFn(groundingAgent);
    await using t = await createTestApp(
      makeApp.bind(null, connectFn, 'ground-user'),
    );

    // POST /session — no mcpServers in body → grounding should inject the app's URL.
    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: process.cwd()});

    // The session should be created (200).
    expect(res.status).toBe(200);

    // resolveOwnMcpUrl resolves via app.get(RestBindings.SERVER) which always
    // succeeds in a started test app, so grounding must always fire — the
    // mcpServers array must be non-empty with a correctly shaped entry.
    expect(capturedMcpServers).toBeDefined();
    expect(capturedMcpServers!.length).toBeGreaterThan(0);

    const srv = capturedMcpServers![0] as {
      type: string;
      name: string;
      url: string;
    };
    expect(srv.type).toBe('http');
    expect(srv.name).toBe('agentback-app');
    expect(typeof srv.url).toBe('string');
    // URL must end with the default mcp-http path.
    expect(srv.url).toMatch(/\/mcp$/);
    // URL must include the running server's base (http://127.0.0.1:<port>).
    expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    // The grounded URL must match the test server's own URL.
    expect(srv.url).toBe(`${t.url}/mcp`);
  });

  it('injects the AgentBack framework guide as standing context on session create', async () => {
    const prompts: string[] = [];
    const guideAgent = acpAgent({name: 'guide-agent'});
    guideAgent.onRequest('initialize', async () => ({
      protocolVersion: 1 as const,
      agentCapabilities: {},
    }));
    guideAgent.onRequest('session/new', async () => ({
      sessionId: `guide-session-${Date.now()}`,
      _meta: null,
    }));
    guideAgent.onRequest('session/prompt', async ({params}) => {
      const first = params.prompt[0] as
        | {type: string; text?: string}
        | undefined;
      if (first?.type === 'text' && first.text) prompts.push(first.text);
      return {stopReason: 'end_turn' as const, _meta: null};
    });

    const connectFn = inProcessConnectFn(guideAgent);
    await using t = await createTestApp(
      makeApp.bind(null, connectFn, 'guide-user'),
    );

    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: process.cwd()});
    expect(res.status).toBe(200);

    // createSession awaits the grounding injections before responding, so by now
    // the framework guide must have been sent as a `<system-context>` turn.
    expect(prompts.some(p => p.includes('AgentBack framework guide'))).toBe(
      true,
    );
    expect(prompts.some(p => /@(get|tool|mcpServer)/.test(p))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-1a. disposeAll() drains all sessions and invokes kill on each subprocess
// ---------------------------------------------------------------------------

describe('I-1a: disposeAll() drains sessions and kills subprocesses', () => {
  it('disposeAll invokes dispose on every session and clears the map', async () => {
    // Track kill calls via the kill seam.
    const killCalls: string[] = [];

    // Build a connect function that records kill invocations.
    function trackingConnectFn(sessionLabel: string): AcpConnectFn {
      return async (
        _descriptor: AgentDescriptor,
        clientApp: ClientApp,
      ): Promise<{
        connection: ClientConnection;
        ctx: ClientContext;
        kill: () => void;
      }> => {
        const fakeAgent = makeFakeAgent();
        const connection = clientApp.connect(fakeAgent);
        const ctx = connection.agent;
        const kill = () => {
          killCalls.push(sessionLabel);
        };
        return {connection, ctx, kill};
      };
    }

    const {AcpSession} = await import('../../acp-session.js');
    const {ChatBridgeController: Ctrl} =
      await import('../../bridge.controller.js');

    // Build a minimal app just to satisfy the DI constructor.
    const app = new RestApplication({rest: {port: 0}});
    const ctrl = new Ctrl(
      app as unknown as import('@agentback/core').Application,
      undefined,
    );

    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };

    // Manually create two sessions and insert them into the controller map.
    const session1 = new AcpSession(descriptor, trackingConnectFn('s1'));
    await session1.connect();
    const sid1 = await session1.open([], process.cwd());

    const session2 = new AcpSession(descriptor, trackingConnectFn('s2'));
    await session2.connect();
    const sid2 = await session2.open([], process.cwd());

    // Insert directly (bypassing POST /session to avoid TTL timers).
    (
      ctrl.sessions as Map<
        string,
        {
          session: typeof session1;
          acpSessionId: string;
          sseDisconnectedAt: number | null;
          creationTtlTimer: ReturnType<typeof setTimeout> | null;
        }
      >
    ).set(`p:${sid1}`, {
      session: session1,
      acpSessionId: sid1,
      sseDisconnectedAt: null,
      creationTtlTimer: null,
    });
    (
      ctrl.sessions as Map<
        string,
        {
          session: typeof session2;
          acpSessionId: string;
          sseDisconnectedAt: number | null;
          creationTtlTimer: ReturnType<typeof setTimeout> | null;
        }
      >
    ).set(`p:${sid2}`, {
      session: session2,
      acpSessionId: sid2,
      sseDisconnectedAt: null,
      creationTtlTimer: null,
    });

    expect(ctrl.sessions.size).toBe(2);

    ctrl.disposeAll();

    // Map must be empty.
    expect(ctrl.sessions.size).toBe(0);
    // kill must have been called for each session (kill is called from dispose()).
    expect(killCalls).toContain('s1');
    expect(killCalls).toContain('s2');
  });
});

// ---------------------------------------------------------------------------
// I-1b. Creation-time TTL: never-subscribed session is disposed after TTL
// ---------------------------------------------------------------------------

describe('I-1b: creation TTL disposes a never-subscribed session', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('session is disposed when TTL fires before SSE subscribe', async () => {
    // Track kill calls.
    const killed: string[] = [];
    const killTrackingConnectFn: AcpConnectFn = async (
      _descriptor: AgentDescriptor,
      clientApp: ClientApp,
    ): Promise<{
      connection: ClientConnection;
      ctx: ClientContext;
      kill: () => void;
    }> => {
      const fakeAgent = makeFakeAgent();
      const connection = clientApp.connect(fakeAgent);
      const ctx = connection.agent;
      const kill = () => {
        killed.push('killed');
      };
      return {connection, ctx, kill};
    };

    const connectFn = killTrackingConnectFn;
    await using t = await createTestApp(
      makeApp.bind(null, connectFn, 'ttl-user'),
    );

    // Create a session but do NOT subscribe to SSE.
    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: process.cwd()});
    expect(res.status).toBe(200);
    const sessionId = (res.body as {sessionId: string}).sessionId;

    // Resolve the controller and verify the session is in the map.
    const ctrl = await t.app.get<ChatBridgeController>(
      'controllers.ChatBridgeController',
    );
    // The session should exist initially.
    const anyEntry = [...ctrl.sessions.values()].find(
      e => e.acpSessionId === sessionId,
    );
    expect(anyEntry).toBeDefined();

    // Advance fake time past the TTL (SSE_RECONNECT_LEASE_MS = 30_000).
    vi.advanceTimersByTime(31_000);

    // After TTL fires, session must be removed from the map.
    const afterEntry = [...ctrl.sessions.values()].find(
      e => e.acpSessionId === sessionId,
    );
    expect(afterEntry).toBeUndefined();
    // kill must have been invoked.
    expect(killed.length).toBeGreaterThan(0);
  });

  it('subscribing to SSE cancels the creation TTL so the session survives', async () => {
    // This test verifies that after SSE subscribes the session is NOT disposed
    // when the TTL would have fired.  We use handleSseRequest directly.
    const {AcpSession} = await import('../../acp-session.js');
    const {ChatBridgeController: Ctrl, SSE_RECONNECT_LEASE_MS: LEASE_MS} =
      await import('../../bridge.controller.js');

    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };
    const session = new AcpSession(
      descriptor,
      inProcessConnectFn(makeFakeAgent()),
    );
    await session.connect();
    const acpSessionId = await session.open([], process.cwd());

    // Build a minimal controller and manually inject the session with a live TTL.
    const app = new RestApplication({rest: {port: 0}});
    const ctrl = new Ctrl(
      app as unknown as import('@agentback/core').Application,
      undefined,
    );

    const key = `p:${acpSessionId}`;
    let timerFired = false;
    const ttlTimer = setTimeout(() => {
      timerFired = true;
    }, LEASE_MS);

    (
      ctrl.sessions as Map<
        string,
        {
          session: typeof session;
          acpSessionId: string;
          sseDisconnectedAt: number | null;
          creationTtlTimer: ReturnType<typeof setTimeout> | null;
        }
      >
    ).set(key, {
      session,
      acpSessionId,
      sseDisconnectedAt: null,
      creationTtlTimer: ttlTimer,
    });

    // Simulate SSE subscribe by calling handleSseRequest with a minimal mock.
    const {handleSseRequest} = await import('../../bridge.controller.js');
    const mockRes = {
      setHeader: () => {},
      flushHeaders: () => {},
      writableEnded: false,
      write: () => {},
    };
    const mockReq = {on: () => {}};
    handleSseRequest(
      ctrl.sessions as Parameters<typeof handleSseRequest>[0],
      'p',
      acpSessionId,
      mockReq as unknown as import('express').Request,
      mockRes as unknown as import('express').Response,
    );

    // After SSE connects, the creationTtlTimer in the entry should be null.
    const entry = ctrl.sessions.get(key);
    expect(entry?.creationTtlTimer).toBeNull();

    // Advance time past TTL — the session must still be in the map.
    vi.advanceTimersByTime(LEASE_MS + 1000);
    // The raw ttlTimer would have "fired" but the session wasn't disposed because
    // clearTimeout was called on it.  The session stays in the map (the only
    // removal path post-subscribe is the reconnect-lease GC, which requires a
    // disconnect first).
    expect(ctrl.sessions.has(key)).toBe(true);

    // Sanity: our sentinel flag is false (the timer we made was cleared).
    expect(timerFired).toBe(false);

    clearTimeout(ttlTimer); // cleanup (already cleared, but harmless)
    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// I-2. Native-listener guard: install() is a no-op on native/edge host
// ---------------------------------------------------------------------------

describe('I-2: chatConsoleFeature install() no-ops on native-listener host', () => {
  it('does not throw and mounts nothing when the REST server uses native listener', async () => {
    // Build an app with listener:'native'.
    // We don't call app.start() — we just install the feature and verify it
    // returns without mounting a controller.
    const {chatConsoleFeature} = await import('../../feature.js');

    // A RestApplication with listener:'native' is an EdgeRestApplication
    // equivalent.  We use RestApplication with the native listener config.
    const app = new RestApplication({rest: {port: 0, listener: 'native'}});

    const feature = chatConsoleFeature({enabled: true});

    // install() must not throw.
    await expect(
      feature.install(
        app as unknown as import('@agentback/rest').RestApplication,
      ),
    ).resolves.toBeUndefined();

    // The bridge controller must NOT have been registered — the controllers
    // binding key should be absent.
    const isBound = app.isBound('controllers.ChatBridgeController');
    expect(isBound).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I-4. GET /agents uses injected CHAT_DISCOVER fn (cwd-aware discover seam)
// ---------------------------------------------------------------------------

describe('GET /agents: uses injected CHAT_DISCOVER when bound', () => {
  it('returns the agents supplied by the injected discover function', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    const app = new RestApplication({rest: {port: 0}});
    app.restController(ChatBridgeController);
    app.bind(CHAT_CONNECT_FN.key).to(connectFn);
    // Bind a stub discover function that always returns a fixed set.
    const stubAgents = [{id: 'my-agent', name: 'My Agent'}];
    app.bind(CHAT_DISCOVER.key).to(() => Promise.resolve(stubAgents));

    await using t = await createTestApp(() => app);

    const res = await t.http.get('/console/chat/agents');
    expect(res.status).toBe(200);
    const body = res.body as {agents: {id: string; name: string}[]};
    expect(body.agents).toEqual(stubAgents);
  });

  it('falls back to a default probe when CHAT_DISCOVER is not bound', async () => {
    // Without a CHAT_DISCOVER binding, GET /agents uses discoverAgents() with
    // makeProbe() (no baseDir). This test just verifies the fallback path does
    // not throw and returns an array (content depends on what is installed).
    const connectFn = inProcessConnectFn(makeFakeAgent());
    const app = new RestApplication({rest: {port: 0}});
    app.restController(ChatBridgeController);
    app.bind(CHAT_CONNECT_FN.key).to(connectFn);
    // No CHAT_DISCOVER binding.

    await using t = await createTestApp(() => app);

    const res = await t.http.get('/console/chat/agents');
    expect(res.status).toBe(200);
    const body = res.body as {agents: unknown[]};
    expect(Array.isArray(body.agents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// I-5. AcpSession.baseDir: defaultConnectFn receives baseDir via options
// ---------------------------------------------------------------------------

describe('AcpSession.baseDir: spawn uses buildAugmentedPath(baseDir)', () => {
  it('AcpSession passes baseDir to connectFn as options.baseDir', async () => {
    // Capture options passed to the connect function.
    let capturedBaseDir: string | undefined;
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };

    const fakeAgent = makeFakeAgent();
    const capturingConnectFn: import('../../acp-session.js').AcpConnectFn =
      async (_desc, clientApp, options) => {
        capturedBaseDir = options?.baseDir;
        const connection = clientApp.connect(fakeAgent);
        const ctx = connection.agent;
        return {connection, ctx, kill: () => {}};
      };

    const {AcpSession} = await import('../../acp-session.js');
    const expectedBaseDir = '/some/project/dir';
    const session = new AcpSession(
      descriptor,
      capturingConnectFn,
      expectedBaseDir,
    );
    await session.connect();

    expect(capturedBaseDir).toBe(expectedBaseDir);

    session.dispose();
  });

  it('AcpSession with no baseDir passes undefined options.baseDir', async () => {
    let capturedBaseDir: string | undefined = 'NOT_SET';
    const descriptor: AgentDescriptor = {
      id: 'test',
      name: 'Test',
      detect: {bin: 'test'},
      command: ['test'],
    };

    const fakeAgent = makeFakeAgent();
    const capturingConnectFn: import('../../acp-session.js').AcpConnectFn =
      async (_desc, clientApp, options) => {
        capturedBaseDir = options?.baseDir;
        const connection = clientApp.connect(fakeAgent);
        const ctx = connection.agent;
        return {connection, ctx, kill: () => {}};
      };

    const {AcpSession} = await import('../../acp-session.js');
    // No baseDir provided.
    const session = new AcpSession(descriptor, capturingConnectFn);
    await session.connect();

    expect(capturedBaseDir).toBeUndefined();

    session.dispose();
  });
});

// ---------------------------------------------------------------------------
// I-6. createSession passes cwd to AcpSession as baseDir
// ---------------------------------------------------------------------------

describe('createSession: cwd from POST body reaches AcpSession as baseDir', () => {
  it('cwd in POST body is forwarded to the AcpSession connectFn as baseDir', async () => {
    let capturedBaseDir: string | undefined = 'NOT_SET';
    const fakeAgent = makeFakeAgent();

    // A connect function that captures the baseDir option.
    const capturingConnectFn: import('../../acp-session.js').AcpConnectFn =
      async (_desc, clientApp, options) => {
        capturedBaseDir = options?.baseDir;
        const connection = clientApp.connect(fakeAgent);
        const ctx = connection.agent;
        return {connection, ctx, kill: () => {}};
      };

    const connectFn = capturingConnectFn;
    await using t = await createTestApp(
      makeApp.bind(null, connectFn, 'cwd-user'),
    );

    const expectedCwd = '/path/to/my/project';
    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: expectedCwd});

    expect(res.status).toBe(200);
    expect(capturedBaseDir).toBe(expectedCwd);
  });

  it('cwd omitted from POST body → baseDir is undefined', async () => {
    let capturedBaseDir: string | undefined = 'NOT_SET';
    const fakeAgent = makeFakeAgent();

    const capturingConnectFn: import('../../acp-session.js').AcpConnectFn =
      async (_desc, clientApp, options) => {
        capturedBaseDir = options?.baseDir;
        const connection = clientApp.connect(fakeAgent);
        const ctx = connection.agent;
        return {connection, ctx, kill: () => {}};
      };

    await using t = await createTestApp(
      makeApp.bind(null, capturingConnectFn, 'cwd-user2'),
    );

    // No cwd in body → undefined baseDir.
    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code'});

    expect(res.status).toBe(200);
    expect(capturedBaseDir).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// W-1. workspaceRoot: createSession passes CHAT_WORKSPACE_ROOT to open()
// ---------------------------------------------------------------------------

describe('workspaceRoot: CHAT_WORKSPACE_ROOT is used as agent editing root', () => {
  it('open() receives the server-configured workspaceRoot, not the POST body cwd', async () => {
    // Capture the cwd passed to session/new via the fake agent.
    let capturedSessionCwd: string | undefined;

    const workspaceAgent = acpAgent({name: 'workspace-agent'});
    workspaceAgent.onRequest('initialize', async () => ({
      protocolVersion: 1 as const,
      agentCapabilities: {},
    }));
    workspaceAgent.onRequest('session/new', async ({params}) => {
      capturedSessionCwd = (params as {cwd?: string}).cwd;
      return {
        sessionId: `workspace-session-${Date.now()}`,
        _meta: null,
      };
    });
    workspaceAgent.onRequest('session/prompt', async () => ({
      stopReason: 'end_turn' as const,
      _meta: null,
    }));

    const connectFn = inProcessConnectFn(workspaceAgent);

    // Build app with CHAT_WORKSPACE_ROOT bound to a known path.
    const expectedWorkspaceRoot = '/server/controlled/root';
    const app = new RestApplication({rest: {port: 0}});
    app.restController(ChatBridgeController);
    app.bind(CHAT_CONNECT_FN.key).to(connectFn);
    app.bind(CHAT_WORKSPACE_ROOT.key).to(expectedWorkspaceRoot);
    app.expressMiddleware(
      'middleware.test.auth',
      (
        req: import('express').Request,
        _res: import('express').Response,
        next: import('express').NextFunction,
      ) => {
        (
          req as import('express').Request & {
            auth?: {token: string; clientId: string; scopes: string[]};
          }
        ).auth = {
          token: 'test',
          clientId: 'ws-user',
          scopes: [],
        };
        next();
      },
    );

    await using t = await createTestApp(() => app);

    // POST body sends a DIFFERENT cwd — must NOT reach AcpSession.open() as the root.
    const clientBodyCwd = '/client/attempted/override';
    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: clientBodyCwd});

    expect(res.status).toBe(200);

    // The session/new cwd must be the server-configured workspaceRoot.
    expect(capturedSessionCwd).toBe(expectedWorkspaceRoot);
    // The client body cwd must NOT have been used as the agent root.
    expect(capturedSessionCwd).not.toBe(clientBodyCwd);
  });

  it('open() defaults to process.cwd() when CHAT_WORKSPACE_ROOT is not bound', async () => {
    let capturedSessionCwd: string | undefined;

    const noRootAgent = acpAgent({name: 'no-root-agent'});
    noRootAgent.onRequest('initialize', async () => ({
      protocolVersion: 1 as const,
      agentCapabilities: {},
    }));
    noRootAgent.onRequest('session/new', async ({params}) => {
      capturedSessionCwd = (params as {cwd?: string}).cwd;
      return {sessionId: `no-root-session-${Date.now()}`, _meta: null};
    });
    noRootAgent.onRequest('session/prompt', async () => ({
      stopReason: 'end_turn' as const,
      _meta: null,
    }));

    const connectFn = inProcessConnectFn(noRootAgent);
    await using t = await createTestApp(
      makeApp.bind(null, connectFn, 'noroot-user'),
    );

    // No CHAT_WORKSPACE_ROOT binding — should default to process.cwd().
    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code'});

    expect(res.status).toBe(200);
    // AcpSession.open() defaults to process.cwd() when cwd is undefined.
    expect(capturedSessionCwd).toBe(process.cwd());
  });

  it('POST body cwd still reaches AcpSession as the spawn baseDir (spawnBase)', async () => {
    // The POST body cwd is used for spawn PATH augmentation (the adapter-discovery
    // base), NOT for the agent editing root.  Verify it still reaches connectFn
    // as options.baseDir.
    let capturedBaseDir: string | undefined = 'NOT_SET';
    const fakeAgent = makeFakeAgent();

    const capturingConnectFn: import('../../acp-session.js').AcpConnectFn =
      async (_desc, clientApp, options) => {
        capturedBaseDir = options?.baseDir;
        const connection = clientApp.connect(fakeAgent);
        const ctx = connection.agent;
        return {connection, ctx, kill: () => {}};
      };

    // Bind workspaceRoot to something different from the POST body cwd.
    const serverRoot = '/server/workspace';
    const app = new RestApplication({rest: {port: 0}});
    app.restController(ChatBridgeController);
    app.bind(CHAT_CONNECT_FN.key).to(capturingConnectFn);
    app.bind(CHAT_WORKSPACE_ROOT.key).to(serverRoot);
    app.expressMiddleware(
      'middleware.test.auth',
      (
        req: import('express').Request,
        _res: import('express').Response,
        next: import('express').NextFunction,
      ) => {
        (
          req as import('express').Request & {
            auth?: {token: string; clientId: string; scopes: string[]};
          }
        ).auth = {
          token: 'test',
          clientId: 'spawn-user',
          scopes: [],
        };
        next();
      },
    );

    await using t = await createTestApp(() => app);

    const spawnCwd = '/adapter/discovery/base';
    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: spawnCwd});

    expect(res.status).toBe(200);
    // The POST body cwd reaches connectFn as options.baseDir (spawn PATH base).
    expect(capturedBaseDir).toBe(spawnCwd);
    // But it is NOT the agent root — that comes from workspaceRoot (asserted above).
  });
});
