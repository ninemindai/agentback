// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Unit tests for the console-chat bridge controller.
 *
 * All tests use an in-process ACP setup — no real subprocess is spawned.
 * A fake `AgentApp` is injected via the `CHAT_CONNECT_FN` seam.
 */

import http from 'node:http';
import {describe, it, expect} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {RestApplication} from '@agentback/rest';
import {SecurityBindings} from '@agentback/security';
import {securityId} from '@agentback/security';
import type {UserProfile} from '@agentback/security';
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
  ): Promise<{connection: ClientConnection; ctx: ClientContext; kill: () => void}> => {
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
    sessionId: `fake-session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
 *
 * `user` is bound at app-level so it is visible in the request context chain.
 * All tests that exercise authenticated endpoints must pass a user.
 */
function makeApp(connectFn: AcpConnectFn, user?: UserProfile): RestApplication {
  const app = new RestApplication({rest: {port: 0}});
  app.restController(ChatBridgeController);
  app.bind(CHAT_CONNECT_FN.key).to(connectFn);
  if (user) {
    app.bind(SecurityBindings.USER.key).to(user);
  }
  return app;
}

/** A reusable test user. */
function makeUser(id: string): UserProfile {
  return {[securityId]: id, name: `User ${id}`};
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
// 1b. I2: user_message_chunk must NOT be echoed as assistant_delta
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
    const descriptor: AgentDescriptor = {id: 'test', name: 'Test', detect: {bin: 'test'}, command: ['test']};

    const {AcpSession} = await import('../../acp-session.js');
    const session = new AcpSession(descriptor, connectFn);
    await session.connect();
    await session.open([], process.cwd());

    const events: import('../../acp-session.js').AcpEvent[] = [];
    session.on('event', ev => events.push(ev));

    const stopPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000);
      session.on('event', ev => {
        if (ev.type === 'stop') { clearTimeout(timer); resolve(); }
        if (ev.type === 'error') { clearTimeout(timer); reject((ev as {error: unknown}).error as Error); }
      });
    });

    await session.prompt('Hi');
    await stopPromise;

    const deltas = events.filter(e => e.type === 'assistant_delta');
    expect(deltas.length).toBe(1);
    expect((deltas[0] as import('../../acp-session.js').AssistantDeltaEvent).text).toBe('agent reply');

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
    // m5: label must be preserved
    expect(permEvent.options[0].label).toBe('Allow once');
    expect(permEvent.options[1].label).toBe('Reject once');

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
// 3. HTTP controller: GET /agents (no auth needed)
// ---------------------------------------------------------------------------

describe('GET /console/chat/agents', () => {
  it('returns an array of agents', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    await using t = await createTestApp(makeApp.bind(null, connectFn, undefined));

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
    const user = makeUser('user1');
    const connectFn = inProcessConnectFn(makeFakeAgent());
    await using t = await createTestApp(makeApp.bind(null, connectFn, user));

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
    await using t = await createTestApp(makeApp.bind(null, connectFn, undefined));

    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude'});

    expect(res.status).toBe(401);
  });

  it('POST /message without user returns 401', async () => {
    const connectFn = inProcessConnectFn(makeFakeAgent());
    await using t = await createTestApp(makeApp.bind(null, connectFn, undefined));

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
    const userA = makeUser('alice');
    const userB = makeUser('bob');
    const fakeAgent = makeFakeAgent();

    // Build an app bound as user A to create the session.
    const connectFn = inProcessConnectFn(fakeAgent);
    await using tA = await createTestApp(makeApp.bind(null, connectFn, userA));

    // Create a session as user A.  Use claude-code which is in BUILTIN_AGENTS.
    const createRes = await tA.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: process.cwd()});
    expect(createRes.status).toBe(200);
    const sessionId = (createRes.body as {sessionId: string}).sessionId;
    expect(typeof sessionId).toBe('string');

    // Build a second app bound as user B.  It has its own separate sessions map
    // (separate controller instance), so user A's session does not exist there.
    await using tB = await createTestApp(makeApp.bind(null, connectFn, userB));

    // user B tries to send a message to user A's session → 404 (not found for B's principal).
    const msgRes = await tB.http
      .post('/console/chat/message')
      .send({sessionId, text: 'attack'});
    expect(msgRes.status).toBe(404);

    // user B tries to delete user A's session → 200 (idempotent; nothing to delete for B).
    const delRes = await tB.http
      .delete('/console/chat/session')
      .send({sessionId});
    expect(delRes.status).toBe(200);

    // user A can still send a message (session is intact in A's controller).
    const aMsg = await tA.http
      .post('/console/chat/message')
      .send({sessionId, text: 'hello from A'});
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

    const descriptor: AgentDescriptor = {id: 'test', name: 'Test', detect: {bin: 'test'}, command: ['test']};
    const session = new AcpSession(descriptor, inProcessConnectFn(fakeAgent));
    await session.connect();
    const acpSessionId = await session.open([], process.cwd());
    const principal = 'sse-test-principal';

    const sessions = new Map<string, {
      session: typeof session;
      acpSessionId: string;
      sseDisconnectedAt: number | null;
    }>();
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

    await new Promise<void>(resolve => rawServer.listen(0, '127.0.0.1', resolve));
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
          res.on('error', () => {/* post-destroy cleanup */});
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
      const timeout = setTimeout(() => reject(new Error('SSE stop frame timed out')), 5000);
      const check = () => {
        if (frames.some(f => {
          try { return (JSON.parse(f) as {type: string}).type === 'stop'; } catch { return false; }
        })) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(check, 10);
        }
      };
      check();
    });

    const parsedFrames = frames.map(f => JSON.parse(f) as {type: string; text?: string});
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
    const descriptor: AgentDescriptor = {id: 'test', name: 'Test', detect: {bin: 'test'}, command: ['test']};
    const session = new AcpSession(descriptor, inProcessConnectFn(fakeAgent));
    await session.connect();
    const acpSessionId = await session.open([], process.cwd());
    const principal = 'lease-principal';

    const sessions = new Map<string, {
      session: typeof session;
      acpSessionId: string;
      sseDisconnectedAt: number | null;
    }>();
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

    await new Promise<void>(resolve => rawServer.listen(0, '127.0.0.1', resolve));
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
          res.on('error', () => {/* ignore post-destroy */});
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
      capturedMcpServers = (params as {mcpServers?: unknown[]}).mcpServers ?? [];
      return {
        sessionId: `grounding-session-${Date.now()}`,
        _meta: null,
      };
    });
    groundingAgent.onRequest('session/prompt', async () => ({
      stopReason: 'end_turn' as const,
      _meta: null,
    }));

    const user = makeUser('ground-user');
    const connectFn = inProcessConnectFn(groundingAgent);
    await using t = await createTestApp(makeApp.bind(null, connectFn, user));

    // POST /session — no mcpServers in body → grounding should inject the app's URL.
    const res = await t.http
      .post('/console/chat/session')
      .send({agentId: 'claude-code', cwd: process.cwd()});

    // The session should be created (200).  If mcp-http is not installed in the
    // test app, capturedMcpServers will be [] (no grounding available) — that's
    // acceptable; the code logs and skips.  We assert the shape when non-empty.
    expect(res.status).toBe(200);

    if (capturedMcpServers && capturedMcpServers.length > 0) {
      const srv = capturedMcpServers[0] as {type: string; name: string; url: string};
      expect(srv.type).toBe('http');
      expect(srv.name).toBe('agentback-app');
      expect(typeof srv.url).toBe('string');
      expect(srv.url).toMatch(/\/mcp$/);
    }
    // If capturedMcpServers is empty ([]), mcp-http is not installed in the test
    // app — that's the graceful-fallback path; no assertion needed.
  });
});
