// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * HTTP bridge between the browser chat dock and an ACP coding-agent session.
 *
 * Endpoints (all under `/console/chat`):
 *   GET  /agents              — discover available agents
 *   POST /session             — create a new ACP session
 *   GET  /stream?sessionId=…  — SSE event stream for a session
 *   POST /message             — send a prompt to the active session
 *   POST /permission          — resolve a pending permission request
 *   DELETE /session           — terminate a session
 *
 * Session map key: `${principal}:${sessionId}`.
 * Principal: `x-principal` || `x-forwarded-user` || `'anonymous'`.
 * This controller assumes it is mounted behind console auth middleware.
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
import {loggers} from '@agentback/common';
import type {Application} from '@agentback/core';
import type {Request, Response} from 'express';
import {BUILTIN_AGENTS, discoverAgents} from './agents.js';
import {AcpSession, type AcpConnectFn, type AcpEvent} from './acp-session.js';
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
});

const SessionResponse = z.object({
  sessionId: z.string(),
});

const StreamQuery = z.object({
  sessionId: z.string(),
});

const MessageRequest = z.object({
  sessionId: z.string(),
  text: z.string().min(1),
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
const SSE_HEARTBEAT_MS = 15_000;

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
  private readonly sessions = new Map<string, SessionEntry>();

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
    input: {body: {agentId: string; cwd?: string}},
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<{sessionId: string}> {
    const {agentId, cwd} = input.body;
    const principal = principalFrom(req);

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

    const acpSession = new AcpSession(
      descriptor,
      this.connectFn,
    );

    await acpSession.connect();
    const acpSessionId = await acpSession.open([], cwd);

    const key = sessionKey(principal, acpSessionId);
    this.sessions.set(key, {
      session: acpSession,
      acpSessionId,
      sseDisconnectedAt: null,
    });

    return {sessionId: acpSessionId};
  }

  // --------------------------------------------------------------------------
  // GET /stream?sessionId=…  (SSE)
  // --------------------------------------------------------------------------

  @get('/stream', {query: StreamQuery})
  async stream(
    input: {query: {sessionId: string}},
    @inject(RestBindings.HTTP_RESPONSE, {optional: true}) res?: Response,
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<void> {
    if (!res || !req) {
      throw new AgentError('SSE requires an HTTP server context', {status: 500, code: 'internal_error'});
    }

    const {sessionId} = input.query;
    const principal = principalFrom(req);
    const key = sessionKey(principal, sessionId);
    const entry = this.sessions.get(key);

    if (!entry) {
      throw new AgentError(`Session not found: ${sessionId}`, {
        status: 404,
        code: 'session_not_found',
      });
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
        const current = this.sessions.get(key);
        if (
          current &&
          current.sseDisconnectedAt !== null &&
          Date.now() - current.sseDisconnectedAt >= SSE_RECONNECT_LEASE_MS
        ) {
          log.debug('GC session after lease expiry sessionId=%s', sessionId);
          current.session.dispose();
          this.sessions.delete(key);
        }
      }, SSE_RECONNECT_LEASE_MS + 100);
    };

    req.on('close', cleanup);
  }

  // --------------------------------------------------------------------------
  // POST /message
  // --------------------------------------------------------------------------

  @post('/message', {body: MessageRequest, response: MessageResponse})
  async message(
    input: {body: {sessionId: string; text: string}},
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<{ok: boolean}> {
    const {sessionId, text} = input.body;
    const principal = principalFrom(req);
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
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<{ok: boolean}> {
    const {sessionId, requestId, optionId} = input.body;
    const principal = principalFrom(req);
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
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<void> {
    const {sessionId} = input.body;
    const principal = principalFrom(req);
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
// Helpers
// ---------------------------------------------------------------------------

function principalFrom(req?: Request): string {
  if (!req) return 'anonymous';
  const h = req.headers as Record<string, string | string[] | undefined>;
  const v = h['x-principal'] ?? h['x-forwarded-user'];
  const raw = Array.isArray(v) ? v[0] : v;
  return raw ?? 'anonymous';
}

function sessionKey(principal: string, sessionId: string): string {
  return `${principal}:${sessionId}`;
}
