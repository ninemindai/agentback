// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * HTTP bridge between the browser chat dock and an ACP coding-agent session.
 *
 * Endpoints (all under `/console/chat`):
 *   GET  /agents              — discover available agents
 *   POST /session             — create a new ACP session
 *   GET  /stream?sessionId=…  — SSE event stream (mounted directly on expressApp
 *                               in feature.ts to prevent RestServer.sendResult
 *                               from terminating the stream — see C2)
 *   POST /message             — send a prompt to the active session
 *   POST /permission          — resolve a pending permission request
 *   DELETE /session           — terminate a session
 *
 * Session map key: `${principal}:${sessionId}`.
 * Principal: derived from the authenticated `SecurityBindings.USER` (securityId).
 * Unauthenticated requests to process-spawning endpoints are rejected (401).
 */

import {z} from 'zod';
import {
  api,
  get,
  post,
  del,
  AgentError,
} from '@agentback/openapi';
import {
  BindingScope,
  BindingKey,
  CoreBindings,
  inject,
  injectable,
} from '@agentback/core';
import {RestBindings} from '@agentback/rest';
import {SecurityBindings, securityId, type UserProfile} from '@agentback/security';
import {loggers} from '@agentback/common';
import type {Application} from '@agentback/core';
import type {Request, Response} from 'express';
import {BUILTIN_AGENTS, discoverAgents} from './agents.js';
import {AcpSession, SpawnError, AcpHandshakeError, type AcpConnectFn, type AcpEvent} from './acp-session.js';
import type {AgentDescriptor} from './types.js';

const log = loggers('agentback:console-chat:bridge');

// ---------------------------------------------------------------------------
// Binding key for the factory seam (injectable in tests)
// ---------------------------------------------------------------------------

/** Binding key for the `AcpConnectFn` factory (injectable for testing). */
export const CHAT_CONNECT_FN = BindingKey.create<AcpConnectFn>(
  'console-chat.connectFn',
);

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const AgentsResponse = z.object({
  agents: z.array(z.object({id: z.string(), name: z.string()})),
});

const SessionRequest = z.object({
  agentId: z.string(),
  cwd: z.string().optional(),
  /** MCP server descriptors to attach to the agent session (Task 7 wiring). */
  mcpServers: z.array(z.unknown()).optional(),
});

const SessionResponse = z.object({
  sessionId: z.string(),
});

const StreamQuery = z.object({
  sessionId: z.string(),
});

const FocusDescriptorSchema = z.object({
  kind: z.string(),
  id: z.string(),
  label: z.string().optional(),
});

const MessageRequest = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
  /** Optional focus context forwarded to the agent (reserved for Task 7). */
  focus: FocusDescriptorSchema.optional(),
});

const MessageResponse = z.object({
  ok: z.boolean(),
});

const PermissionRequest = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  optionId: z.string().nullable(),
});

const PermissionResponse = z.object({
  ok: z.boolean(),
});

const DeleteSessionRequest = z.object({
  sessionId: z.string(),
});

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionEntry {
  session: AcpSession;
  /** ACP protocol-level sessionId (string from the agent). */
  acpSessionId: string;
  /** Epoch ms when the last SSE client disconnected (null = client is connected). */
  sseDisconnectedAt: number | null;
}

// Lease window (ms) before a disconnected session is garbage-collected.
const SSE_RECONNECT_LEASE_MS = 30_000;

// SSE heartbeat interval (ms).
export const SSE_HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@injectable({scope: BindingScope.SINGLETON})
@api({basePath: '/console/chat'})
export class ChatBridgeController {
  /**
   * Session map keyed by `${principal}:${acpSessionId}`.
   * All access is synchronous (Node's single-threaded event loop).
   */
  readonly sessions = new Map<string, SessionEntry>();

  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE) private readonly app: Application,
    @inject(CHAT_CONNECT_FN, {optional: true})
    private readonly connectFn?: AcpConnectFn,
  ) {}

  // --------------------------------------------------------------------------
  // GET /agents
  // --------------------------------------------------------------------------

  @get('/agents', {response: AgentsResponse})
  async agents(): Promise<{agents: {id: string; name: string}[]}> {
    const catalog: AgentDescriptor[] = [...BUILTIN_AGENTS];
    const found = await discoverAgents(catalog);
    return {agents: found};
  }

  // --------------------------------------------------------------------------
  // POST /session
  // --------------------------------------------------------------------------

  @post('/session', {body: SessionRequest, response: SessionResponse})
  async createSession(
    input: {body: {agentId: string; cwd?: string; mcpServers?: unknown[]}},
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
  ): Promise<{sessionId: string}> {
    const principal = requirePrincipal(user);
    const {agentId, cwd, mcpServers = []} = input.body;

    // Find agent descriptor.
    const catalog: AgentDescriptor[] = [...BUILTIN_AGENTS];
    const descriptor = catalog.find(a => a.id === agentId);
    if (!descriptor) {
      throw new AgentError(`Unknown agent: ${agentId}`, {
        status: 400,
        code: 'unknown_agent',
      });
    }

    log.debug('createSession principal=%s agentId=%s', principal, agentId);

    const acpSession = new AcpSession(descriptor, this.connectFn);

    try {
      await acpSession.connect();
      const acpSessionId = await acpSession.open(mcpServers, cwd);

      const key = sessionKey(principal, acpSessionId);
      this.sessions.set(key, {
        session: acpSession,
        acpSessionId,
        sseDisconnectedAt: null,
      });

      return {sessionId: acpSessionId};
    } catch (err) {
      // Dispose the session to ensure no subprocess leaks.
      acpSession.dispose();
      if (err instanceof SpawnError) {
        throw new AgentError(
          `Agent process could not be started: ${err.message}`,
          {status: 503, code: 'agent_unavailable'},
        );
      }
      if (err instanceof AcpHandshakeError) {
        throw new AgentError(
          `ACP handshake failed: ${err.message}`,
          {status: 502, code: 'agent_handshake_failed'},
        );
      }
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // GET /stream?sessionId=…  (SSE)
  //
  // NOTE: This @get decorator is kept for OpenAPI schema generation only.
  // The actual SSE handler is mounted directly on expressApp in feature.ts
  // (chatConsoleFeature.install) to prevent RestServer.sendResult from calling
  // res.end() and killing the stream (C2 fix).  Express routes take priority
  // over the framework's route table, so the live handler runs.
  // --------------------------------------------------------------------------

  @get('/stream', {query: StreamQuery})
  async stream(
    input: {query: {sessionId: string}},
    @inject(RestBindings.HTTP_RESPONSE, {optional: true}) res?: Response,
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
  ): Promise<void> {
    // This method should only be reached if the expressApp handler in feature.ts
    // is not mounted (e.g. in tests that do not call install()).  Serve a
    // graceful error rather than silently returning.
    if (!res || !req) {
      throw new AgentError('SSE requires an HTTP server context', {status: 500, code: 'internal_error'});
    }
    const principal = requirePrincipal(user);
    const {sessionId} = input.query;
    handleSseRequest(this.sessions, principal, sessionId, req, res);
  }

  // --------------------------------------------------------------------------
  // POST /message
  // --------------------------------------------------------------------------

  @post('/message', {body: MessageRequest, response: MessageResponse})
  async message(
    input: {body: {sessionId: string; text: string; focus?: {kind: string; id: string; label?: string}}},
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
  ): Promise<{ok: boolean}> {
    const principal = requirePrincipal(user);
    const {sessionId, text} = input.body;
    const entry = this.sessions.get(sessionKey(principal, sessionId));

    if (!entry) {
      throw new AgentError(`Session not found: ${sessionId}`, {
        status: 404,
        code: 'session_not_found',
      });
    }

    await entry.session.prompt(text);
    return {ok: true};
  }

  // --------------------------------------------------------------------------
  // POST /permission
  // --------------------------------------------------------------------------

  @post('/permission', {body: PermissionRequest, response: PermissionResponse})
  async permission(
    input: {body: {sessionId: string; requestId: string; optionId: string | null}},
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
  ): Promise<{ok: boolean}> {
    const principal = requirePrincipal(user);
    const {sessionId, requestId, optionId} = input.body;
    const entry = this.sessions.get(sessionKey(principal, sessionId));

    if (!entry) {
      throw new AgentError(`Session not found: ${sessionId}`, {
        status: 404,
        code: 'session_not_found',
      });
    }

    entry.session.resolvePermission(requestId, optionId);
    return {ok: true};
  }

  // --------------------------------------------------------------------------
  // DELETE /session
  // --------------------------------------------------------------------------

  @del('/session', {body: DeleteSessionRequest})
  async deleteSession(
    input: {body: {sessionId: string}},
    @inject(SecurityBindings.USER, {optional: true}) user?: UserProfile,
  ): Promise<void> {
    const principal = requirePrincipal(user);
    const {sessionId} = input.body;
    const key = sessionKey(principal, sessionId);
    const entry = this.sessions.get(key);

    if (!entry) {
      // Idempotent — already gone.
      return;
    }

    log.debug('deleteSession principal=%s sessionId=%s', principal, sessionId);
    entry.session.dispose();
    this.sessions.delete(key);
  }
}

// ---------------------------------------------------------------------------
// SSE handler — shared by the expressApp raw mount (C2) and the fallback @get
// ---------------------------------------------------------------------------

/**
 * Writes SSE headers, forwards AcpEvents, sends heartbeats, and GCs the
 * session after the lease window when the client disconnects.
 *
 * Exported so `feature.ts` can mount it on expressApp directly.
 */
export function handleSseRequest(
  sessions: Map<string, SessionEntry>,
  principal: string,
  sessionId: string,
  req: Request,
  res: Response,
): void {
  const key = sessionKey(principal, sessionId);
  const entry = sessions.get(key);

  if (!entry) {
    res.status(404).json({error: 'session_not_found', message: `Session not found: ${sessionId}`});
    return;
  }

  // Mark the session as having an active SSE client.
  entry.sseDisconnectedAt = null;

  // SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();

  const send = (ev: AcpEvent | {type: 'heartbeat'}): void => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  };

  // Forward events from the session.
  const onEvent = (ev: AcpEvent): void => send(ev);
  entry.session.on('event', onEvent);

  // Heartbeat timer.
  const heartbeat = setInterval(() => send({type: 'heartbeat'}), SSE_HEARTBEAT_MS);

  // Cleanup when the client disconnects.
  const cleanup = (): void => {
    clearInterval(heartbeat);
    entry.session.off('event', onEvent);
    entry.sseDisconnectedAt = Date.now();
    log.debug('SSE client disconnected sessionId=%s', sessionId);

    // Schedule garbage-collection after the lease window.
    setTimeout(() => {
      const current = sessions.get(key);
      if (
        current &&
        current.sseDisconnectedAt !== null &&
        Date.now() - current.sseDisconnectedAt >= SSE_RECONNECT_LEASE_MS
      ) {
        log.debug('GC session after lease expiry sessionId=%s', sessionId);
        current.session.dispose();
        sessions.delete(key);
      }
    }, SSE_RECONNECT_LEASE_MS + 100);
  };

  req.on('close', cleanup);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the principal id from an authenticated `UserProfile`.
 * Throws 401 if no authenticated user is present — do NOT fall back to
 * 'anonymous' for process-spawning endpoints.
 */
function requirePrincipal(user: UserProfile | undefined): string {
  if (!user) {
    throw new AgentError('Authentication required', {status: 401, code: 'unauthenticated'});
  }
  return user[securityId];
}

function sessionKey(principal: string, sessionId: string): string {
  return `${principal}:${sessionId}`;
}
