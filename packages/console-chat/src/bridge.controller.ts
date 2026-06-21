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
 * Principal: derived from `req.auth` (set by the console `auth` guard middleware).
 * Both the @api endpoints and the SSE stream use the same `principalFromRequest`
 * helper — one canonical source of truth. Unauthenticated requests are rejected (401).
 *
 * Lifecycle notes:
 *   - A session created via POST /session starts a creation-TTL timer (TTL =
 *     SSE_RECONNECT_LEASE_MS). If the SSE stream has not subscribed by the time
 *     the timer fires, the session is disposed (prevents a never-subscribed leak).
 *   - When the SSE stream connects, the creation-TTL timer is cancelled.
 *   - On app.stop(), disposeAll() is called to drain all live sessions and kill
 *     any subprocesses (wired by chatConsoleFeature.install).
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
import type {RestServer} from '@agentback/rest';
import {securityId} from '@agentback/security';
import type {UserProfile} from '@agentback/security';
import type {AuthInfo} from '@agentback/mcp-http';
import {loggers} from '@agentback/common';
import type {Application} from '@agentback/core';
import {buildOkfBundle, type OkfBundle} from '@agentback/schema-explorer';
import type {Request, Response} from 'express';
import {BUILTIN_AGENTS, discoverAgents, makeProbe} from './agents.js';
import {AcpSession, SpawnError, AcpHandshakeError, type AcpConnectFn, type AcpEvent} from './acp-session.js';
import type {AgentDescriptor} from './types.js';

const log = loggers('agentback:console-chat:bridge');

// ---------------------------------------------------------------------------
// Type alias for the discover function seam
// ---------------------------------------------------------------------------

/** The discover function type: returns available agents for the given catalog. */
export type DiscoverFn = () => Promise<{id: string; name: string}[]>;

// ---------------------------------------------------------------------------
// Grounding helpers
// ---------------------------------------------------------------------------

/** Default mcp-http path. */
const DEFAULT_MCP_PATH = '/mcp';

/**
 * Resolve the app's own mcp-http base URL.
 *
 * Returns `<serverUrl><mcpPath>` if the RestServer is available, else `null`.
 * The mcp-http path defaults to {@link DEFAULT_MCP_PATH} — there is no
 * binding for it; we use the default.
 */
async function resolveOwnMcpUrl(app: Application): Promise<string | null> {
  try {
    const server = await app.get<RestServer>(RestBindings.SERVER);
    if (!server || typeof server.url !== 'string') return null;
    return `${server.url}${DEFAULT_MCP_PATH}`;
  } catch {
    return null;
  }
}

/**
 * Build an OKF brief for standing context.
 *
 * Size guard: if the serialized bundle exceeds 8 KB, only include the index
 * file (progressive-disclosure: the agent can call `get_okf_bundle` for the
 * full schema).  Returns `null` if the bundle is empty or building fails.
 */
function buildOkfBrief(app: Application): string | null {
  const SIZE_LIMIT = 8192; // 8 KB
  try {
    const bundle: OkfBundle = buildOkfBundle(app as unknown as import('@agentback/core').Context);
    if (!bundle.files.length) return null;

    // Try to fit the full bundle.
    const full = bundle.files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');
    if (full.length <= SIZE_LIMIT) return full;

    // Fallback: index only.
    const indexFile = bundle.files.find(f => f.path === 'index.md');
    if (indexFile) {
      return (
        indexFile.content +
        '\n\n*(Bundle too large to inline. Call the `get_okf_bundle` tool for the full schema.)*'
      );
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Binding key for the factory seam (injectable in tests)
// ---------------------------------------------------------------------------

/** Binding key for the `AcpConnectFn` factory (injectable for testing). */
export const CHAT_CONNECT_FN = BindingKey.create<AcpConnectFn>(
  'console-chat.connectFn',
);

/**
 * Binding key for the discover function.
 *
 * When bound (e.g. by `chatConsoleFeature().install()`), `GET /agents` uses
 * this function instead of the static default so discovery is cwd-aware
 * (workspace devDependency adapters under the consumer package's
 * `node_modules/.bin` are found without a global install).
 *
 * Tests can also bind a stub here to control which agents are returned.
 */
export const CHAT_DISCOVER = BindingKey.create<DiscoverFn>(
  'console-chat.discoverFn',
);

/**
 * Binding key for the configured working directory.
 *
 * Bound by `chatConsoleFeature().install()` to the feature's `config.cwd`. Used
 * as the default base dir for spawning the agent (PATH augmentation) when a
 * `POST /session` request doesn't carry its own `cwd` — which the browser dock
 * never does. Without this, the spawn falls back to `process.cwd()` and can't
 * find a workspace devDependency adapter under the app's `node_modules/.bin`.
 */
export const CHAT_CWD = BindingKey.create<string>('console-chat.cwd');

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
  /**
   * Timer that fires if the session is never SSE-subscribed within the
   * creation TTL window. Cleared when the SSE stream connects.
   */
  creationTtlTimer: ReturnType<typeof setTimeout> | null;
}

// Lease window (ms) before a disconnected session is garbage-collected.
// Also used as the creation-TTL window: a session never subscribed via SSE
// is disposed after this many ms to prevent unbounded session accumulation.
export const SSE_RECONNECT_LEASE_MS = 30_000;

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
    @inject(CHAT_DISCOVER, {optional: true})
    private readonly discoverFn?: DiscoverFn,
    @inject(CHAT_CWD, {optional: true})
    private readonly configuredCwd?: string,
  ) {}

  // --------------------------------------------------------------------------
  // GET /agents
  // --------------------------------------------------------------------------

  @get('/agents', {response: AgentsResponse})
  async agents(): Promise<{agents: {id: string; name: string}[]}> {
    // When a CHAT_DISCOVER fn is bound (installed by chatConsoleFeature), use it
    // so discovery is cwd-aware (workspace devDependency adapters are found via
    // buildAugmentedPath(cwd)). Fall back to a static probe with no baseDir when
    // running outside the feature install path (e.g. tests that bind the
    // controller directly without calling install).
    const discover =
      this.discoverFn ??
      (() => discoverAgents([...BUILTIN_AGENTS], makeProbe()));
    const found = await discover();
    return {agents: found};
  }

  // --------------------------------------------------------------------------
  // POST /session
  // --------------------------------------------------------------------------

  @post('/session', {body: SessionRequest, response: SessionResponse})
  async createSession(
    input: {body: {agentId: string; cwd?: string; mcpServers?: unknown[]}},
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<{sessionId: string}> {
    const principal = principalFromRequest(req);
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

    // Base dir for PATH augmentation during spawn so a workspace devDependency
    // adapter (isolated under the app's node_modules/.bin) is found — matching
    // what feature.ts does for discovery. Prefer the request's cwd, else the
    // feature's configured cwd (CHAT_CWD); the browser dock sends no cwd, so the
    // configured default is what makes the dock actually spawn the adapter.
    const spawnBase = cwd ?? this.configuredCwd;
    const acpSession = new AcpSession(descriptor, this.connectFn, spawnBase);

    try {
      await acpSession.connect();

      // --- Grounding: register app's own mcp-http if caller didn't supply servers ---
      let groundedServers: unknown[] = mcpServers;
      if (!groundedServers.length) {
        const mcpUrl = await resolveOwnMcpUrl(this.app);
        if (mcpUrl) {
          log.debug('grounding session with app mcp-http url=%s', mcpUrl);
          // NEEDS LIVE VALIDATION (ACP-NOTES §9b): transport type for mcp-http.
          // Using 'http' transport per ACP-NOTES §4 McpServerHttp shape.
          groundedServers = [
            {
              type: 'http' as const,
              name: 'agentback-app',
              url: mcpUrl,
              headers: [],
            },
          ];
        } else {
          log.debug('mcp-http not available; opening session without MCP grounding');
        }
      }

      const acpSessionId = await acpSession.open(groundedServers, cwd);

      // --- Standing context: OKF brief ---
      // NEEDS LIVE VALIDATION (ACP-NOTES §5): whether session.prompt() is the
      // correct mechanism for injecting standing context (no separate
      // session/setContext endpoint visible in the ACP SDK types).
      const brief = buildOkfBrief(this.app);
      if (brief) {
        log.debug('injecting OKF brief as standing context (length=%d)', brief.length);
        await acpSession.injectContext(brief);
      }

      const key = sessionKey(principal, acpSessionId);

      // Creation-time TTL: if no SSE client subscribes within the lease window,
      // dispose the session to prevent unbounded accumulation of never-connected
      // sessions.  The timer is cleared by handleSseRequest when a client
      // connects (see the `creationTtlTimer` field on SessionEntry).
      const creationTtlTimer = setTimeout(() => {
        const current = this.sessions.get(key);
        if (current && current.sseDisconnectedAt === null && current.creationTtlTimer !== null) {
          log.debug('creation TTL expired for never-subscribed session sessionId=%s', acpSessionId);
          current.session.dispose();
          this.sessions.delete(key);
        }
      }, SSE_RECONNECT_LEASE_MS);

      this.sessions.set(key, {
        session: acpSession,
        acpSessionId,
        sseDisconnectedAt: null,
        creationTtlTimer,
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
  ): Promise<void> {
    // This method should only be reached if the expressApp handler in feature.ts
    // is not mounted (e.g. in tests that do not call install()).  Serve a
    // graceful error rather than silently returning.
    if (!res || !req) {
      throw new AgentError('SSE requires an HTTP server context', {status: 500, code: 'internal_error'});
    }
    const principal = principalFromRequest(req);
    const {sessionId} = input.query;
    handleSseRequest(this.sessions, principal, sessionId, req, res);
  }

  // --------------------------------------------------------------------------
  // POST /message
  // --------------------------------------------------------------------------

  @post('/message', {body: MessageRequest, response: MessageResponse})
  async message(
    input: {body: {sessionId: string; text: string; focus?: {kind: string; id: string; label?: string}}},
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<{ok: boolean}> {
    const principal = principalFromRequest(req);
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
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<{ok: boolean}> {
    const principal = principalFromRequest(req);
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
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
  ): Promise<void> {
    const principal = principalFromRequest(req);
    const {sessionId} = input.body;
    const key = sessionKey(principal, sessionId);
    const entry = this.sessions.get(key);

    if (!entry) {
      // Idempotent — already gone.
      return;
    }

    log.debug('deleteSession principal=%s sessionId=%s', principal, sessionId);
    if (entry.creationTtlTimer !== null) {
      clearTimeout(entry.creationTtlTimer);
    }
    entry.session.dispose();
    this.sessions.delete(key);
  }

  // --------------------------------------------------------------------------
  // Shutdown / cleanup
  // --------------------------------------------------------------------------

  /**
   * Disposes every live session and clears the session map.
   *
   * Called by `chatConsoleFeature().install()` via `app.onStop()` so that all
   * ACP subprocesses are killed when the app shuts down — no orphaned processes.
   * Also cancels any pending creation-TTL timers.
   */
  disposeAll(): void {
    log.debug('disposeAll: draining %d sessions', this.sessions.size);
    for (const [, entry] of this.sessions) {
      if (entry.creationTtlTimer !== null) {
        clearTimeout(entry.creationTtlTimer);
      }
      entry.session.dispose();
    }
    this.sessions.clear();
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

  // Cancel the creation-TTL timer — the client has connected, so the
  // "never-subscribed" leak path is closed.
  if (entry.creationTtlTimer !== null) {
    clearTimeout(entry.creationTtlTimer);
    entry.creationTtlTimer = null;
  }

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
 * Derives the stable principal id from the request's `req.auth` field.
 *
 * The console `auth` guard middleware MUST set `req.auth` before any bridge
 * endpoint is reached. Two shapes are supported:
 * - `AuthInfo` (set by `frameworkAuthGuard` / `requireBearerAuth`): uses
 *   `authInfo.clientId`.
 * - `UserProfile` (legacy / custom middleware): uses `profile[securityId]`.
 *
 * Throws `401 unauthenticated` if `req.auth` is absent or yields no id.
 * Export so `feature.ts` can use the same logic for the SSE handler.
 */
export function principalFromRequest(req: Request | undefined): string {
  if (!req) {
    throw new AgentError('Authentication required', {status: 401, code: 'unauthenticated'});
  }
  const auth = (req as Request & {auth?: AuthInfo | UserProfile}).auth;
  if (!auth) {
    throw new AgentError('Authentication required', {status: 401, code: 'unauthenticated'});
  }
  // AuthInfo shape (from mcp-http frameworkAuthGuard or SDK requireBearerAuth).
  const asAuthInfo = auth as AuthInfo;
  if (typeof asAuthInfo.clientId === 'string' && asAuthInfo.clientId) {
    return asAuthInfo.clientId;
  }
  // UserProfile shape (custom middleware setting req.auth to a UserProfile).
  const asUserProfile = auth as UserProfile;
  const id = asUserProfile[securityId];
  if (typeof id === 'string' && id) {
    return id;
  }
  throw new AgentError('Authentication required', {status: 401, code: 'unauthenticated'});
}

function sessionKey(principal: string, sessionId: string): string {
  return `${principal}:${sessionId}`;
}
