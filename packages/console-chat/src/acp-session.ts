// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * ACP session lifecycle management for the console-chat dock.
 *
 * `AcpSession` wraps an ACP `ClientApp` + `ClientConnection`, drives the
 * `session/new` → `session/prompt` lifecycle, and re-emits typed events to
 * the SSE bridge controller via an `EventEmitter`.
 *
 * A `connectFn` seam allows tests to inject an in-process `AgentApp` instead
 * of spawning a real subprocess.
 */

import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {Readable, Writable} from 'node:stream';
import {
  client as acpClient,
  type ClientApp,
  type ClientConnection,
  type ClientContext,
  type ActiveSession,
  type ActiveSessionMessage,
  type SessionModeState,
  ndJsonStream,
  type Stream,
} from '@agentclientprotocol/sdk';
import {loggers} from '@agentback/common';
import type {AgentDescriptor} from './types.js';

const log = loggers('agentback:console-chat:acp-session');

// ---------------------------------------------------------------------------
// Typed event union
// ---------------------------------------------------------------------------

export interface AssistantDeltaEvent {
  type: 'assistant_delta';
  text: string;
}

export interface ToolCallEvent {
  type: 'tool_call';
  toolCallId: string;
  title?: string | null;
  status?: string | null;
}

export interface PermissionRequestEvent {
  type: 'permission_request';
  /** Stable request ID to pass back via resolvePermission(). */
  requestId: string;
  toolCall: unknown;
  options: Array<{optionId: string; kind: string; label?: string}>;
}

export interface StopEvent {
  type: 'stop';
  stopReason: string;
}

export interface ErrorEvent {
  type: 'error';
  error: unknown;
}

export type AcpEvent =
  | AssistantDeltaEvent
  | ToolCallEvent
  | PermissionRequestEvent
  | StopEvent
  | ErrorEvent;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class SpawnError extends Error {
  constructor(
    message: string,
    public readonly code?: number | null,
  ) {
    super(message);
    this.name = 'SpawnError';
  }
}

export class AcpHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcpHandshakeError';
  }
}

export class PartialTurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartialTurnError';
  }
}

// ---------------------------------------------------------------------------
// Connect function seam
// ---------------------------------------------------------------------------

/**
 * Factory for an ACP connection.
 *
 * The default implementation spawns a subprocess and bridges Node stdio →
 * Web Streams.  Tests inject an in-process `AgentApp` via this seam.
 *
 * @returns A `ClientConnection`, the `ClientContext` obtained from it, and a
 *   `kill` function that terminates the underlying transport (e.g. the child
 *   process).  For in-process connections `kill` is a no-op.
 */
export type AcpConnectFn = (
  descriptor: AgentDescriptor,
  clientApp: ClientApp,
) => Promise<{connection: ClientConnection; ctx: ClientContext; kill: () => void}>;

/**
 * Default connect function: spawns the subprocess indicated by
 * `descriptor.command[0]` (+ remaining args) and bridges stdio via
 * `ndJsonStream`.
 *
 * NEEDS LIVE VALIDATION (ACP-NOTES §9a): Node stdio → Web Streams bridging.
 * `Readable.toWeb()` and `Writable.toWeb()` are available in Node 17+ but
 * their behaviour under backpressure with JSON-RPC framing is not yet
 * battle-tested.  The subprocess's `stdout` is the input to the SDK (the
 * agent writes to it); the SDK's output is piped to the subprocess's `stdin`.
 * NEEDS LIVE VALIDATION (ACP-NOTES §9b): Transport advertised by
 * claude-agent-acp.  The binary may prefer HTTP/SSE rather than stdio; update
 * this function once the real adapter is available.
 */
export const defaultConnectFn: AcpConnectFn = async (descriptor, clientApp) => {
  const [bin, ...args] = descriptor.command;
  log.debug('spawning ACP subprocess: %s %o', bin, args);

  const child = spawn(bin, args, {stdio: ['pipe', 'pipe', 'inherit']});

  if (!child.stdout || !child.stdin) {
    throw new SpawnError(`Failed to obtain stdio handles for ${bin}`);
  }

  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', err =>
      reject(new SpawnError(`Failed to spawn ${bin}: ${err.message}`)),
    );
  });

  // NEEDS LIVE VALIDATION (ACP-NOTES §9a): Node streams → Web Streams.
  const inputStream = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const outputStream = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const stream: Stream = ndJsonStream(outputStream, inputStream);

  const connection = clientApp.connect(stream);

  // Resolve the ClientContext from the connection.
  const ctx = connection.agent;

  // If the subprocess dies unexpectedly, close the connection.
  child.once('exit', (code, signal) => {
    if (code !== 0 || signal) {
      log.debug('ACP subprocess exited code=%s signal=%s', code, signal);
      connection.close(
        new SpawnError(`Subprocess exited unexpectedly`, code),
      );
    }
  });

  // kill() terminates the subprocess regardless of how the connection was
  // closed (SIGTERM → child process GC).
  const kill = () => {
    try {
      child.kill();
    } catch {
      // Already exited — ignore.
    }
  };

  return {connection, ctx, kill};
};

// ---------------------------------------------------------------------------
// AcpSession
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of a single ACP coding-agent session.
 *
 * - Call `connect()` once to establish the ACP connection.
 * - Call `open(mcpServers?, cwd?)` to start a protocol session.
 * - Call `prompt(text)` to send a message; events are emitted on `events`.
 * - Call `resolvePermission(requestId, optionId)` to answer a permission request.
 * - Call `dispose()` to close the session and connection.
 */
export class AcpSession extends EventEmitter {
  private _clientApp: ClientApp | null = null;
  private _connection: ClientConnection | null = null;
  private _ctx: ClientContext | null = null;
  private _session: ActiveSession | null = null;
  private _disposed = false;
  /** Kills the underlying subprocess (no-op for in-process connections). */
  private _kill: (() => void) | null = null;
  /**
   * Tracks the in-flight quiet drain of the orientation/grounding turn (see
   * `injectContext`).  The first user `prompt()` awaits this so the shared
   * `nextUpdate()` queue is clean — no orientation chunks or `stop` bleed into
   * the user turn — before the user turn's own drain begins.
   */
  private _groundingDrain: Promise<void> | null = null;

  // Pending permission requests keyed by a stable requestId (we generate a
  // UUID per request so the client can correlate).
  private _pendingPermissions = new Map<
    string,
    (optionId: string | null) => void
  >();

  constructor(
    private readonly descriptor: AgentDescriptor,
    private readonly connectFn: AcpConnectFn = defaultConnectFn,
  ) {
    super();
  }

  // --------------------------------------------------------------------------
  // Public lifecycle API
  // --------------------------------------------------------------------------

  /**
   * Establishes the ACP connection to the agent subprocess (or in-process
   * fake).  Must be called before `open()`.
   */
  async connect(): Promise<void> {
    if (this._disposed) throw new Error('AcpSession: already disposed');

    // Build a ClientApp that handles permission requests.
    const app = acpClient({name: 'agentback-console-chat'});

    app.onRequest('session/request_permission', async ({params}) => {
      const requestId = `perm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      log.debug('permission_request sessionId=%s requestId=%s', params.sessionId, requestId);

      const optionId = await new Promise<string | null>(resolve => {
        this._pendingPermissions.set(requestId, resolve);
        this.emit('event', {
          type: 'permission_request',
          requestId,
          toolCall: params.toolCall,
          options: (params.options ?? []).map(o => ({
            optionId: o.optionId,
            kind: o.kind,
            label: o.name,
          })),
        } satisfies PermissionRequestEvent);
      });

      this._pendingPermissions.delete(requestId);
      // Return the chosen option to the agent.
      // NEEDS LIVE VALIDATION (ACP-NOTES §9e): permission response shape.
      if (optionId === null) {
        return {outcome: {outcome: 'cancelled'}} as const;
      }
      return {
        outcome: {outcome: 'selected', optionId},
      } as const;
    });

    const {connection, ctx, kill} = await this.connectFn(this.descriptor, app);
    this._clientApp = app;
    this._connection = connection;
    this._ctx = ctx;
    this._kill = kill;

    // If the connection closes unexpectedly, emit an error.
    connection.closed.then(() => {
      if (!this._disposed) {
        log.debug('ACP connection closed unexpectedly');
        this.emit('event', {
          type: 'error',
          error: new AcpHandshakeError('ACP connection closed unexpectedly'),
        } satisfies ErrorEvent);
      }
    }).catch(() => {/* closed promise never rejects */});
  }

  /**
   * Creates a new ACP protocol session.  Returns the ACP `sessionId`.
   *
   * @param mcpServers - MCP server descriptors to pass to `session/new`.
   * @param cwd - Working directory for the session (default: `process.cwd()`).
   * @param permissionMode - Target permission mode to enforce after session
   *   creation.  Defaults to `'default'` which makes the adapter route
   *   `session/request_permission` to our client handler so the dock's inline
   *   permission card gates every file edit.  Pass `'acceptEdits'` to bypass
   *   (useful for fully-trusted, sandboxed environments) or `'plan'` for
   *   plan-only mode.
   *
   * NEEDS LIVE VALIDATION (ACP-NOTES §9c): `cwd` requirement — whether the
   * field is truly required by `claude-agent-acp`.
   */
  async open(mcpServers: unknown[] = [], cwd?: string, permissionMode = 'default'): Promise<string> {
    if (!this._ctx) throw new Error('AcpSession: not connected — call connect() first');
    if (this._disposed) throw new Error('AcpSession: already disposed');

    const workingDir = cwd ?? process.cwd();
    log.debug('opening ACP session cwd=%s mcpServers=%d', workingDir, mcpServers.length);

    let builder = this._ctx.buildSession(workingDir);
    for (const srv of mcpServers) {
      builder = builder.withMcpServer(srv as Parameters<typeof builder.withMcpServer>[0]);
    }

    const session = await builder.start();
    this._session = session;
    log.debug('ACP session opened sessionId=%s', session.sessionId);

    // LIVE-VALIDATED (ACP-NOTES §10): forcing 'default' mode so the adapter routes
    // session/request_permission to us — without this, claude-agent-acp defaults to
    // 'acceptEdits' which auto-accepts file edits without ever calling our
    // session/request_permission handler, bypassing the dock's permission card.
    await this._enforcePermissionMode(session.sessionId as string, session.modes, permissionMode);

    return session.sessionId as string;
  }

  /**
   * Injects standing context into the newly-opened session by sending a
   * silent orientation prompt.  The agent consumes it as background context.
   *
   * NEEDS LIVE VALIDATION (ACP-NOTES §5): `session.prompt()` is the only
   * context-injection mechanism visible in the ACP SDK types.  A separate
   * `session/setContext` endpoint does not appear in the 0.28.x types.
   * If the real agent ignores zero-reply prompts this should be a no-op.
   */
  async injectContext(contextText: string): Promise<void> {
    if (this._disposed) throw new Error('AcpSession: already disposed');
    if (!this._session) throw new Error('AcpSession: no open session — call open() first');

    const session = this._session;
    log.debug('injecting standing context (length=%d)', contextText.length);

    // NEEDS LIVE VALIDATION (ACP-NOTES §5): We use prompt() because no
    // session/setContext method is visible in the SDK types.  The agent may
    // or may not respond to this orientation turn.
    //
    // ACP exposes ONE shared `nextUpdate()` queue per session, so we MUST
    // drain this orientation turn quietly here — consuming its chunks + `stop`
    // WITHOUT emitting on the public emitter — otherwise the first user turn's
    // `_drainUpdates` would dequeue the orientation turn's leftovers first,
    // bleeding the brief's reply into the user message and/or emitting a
    // spurious early `stop`.  The drain promise is stored in `_groundingDrain`
    // so the first `prompt()` awaits it before starting the user turn's drain
    // (the two drains never run concurrently on the shared queue).  This is
    // best-effort standing context; failures are logged, never thrown.
    this._groundingDrain = this._drainQuietly(
      session,
      `<system-context>\n${contextText}\n</system-context>\n\n` +
        'You are an AI coding agent integrated with an AgentBack application. ' +
        'The schema above describes the running app\'s REST routes, MCP tools, ' +
        'and domain entities. Use it to understand the application before making changes.',
    );
  }

  /**
   * Sends a prompt to the open session and starts streaming update events.
   * Returns as soon as the message is queued; events flow asynchronously on
   * the emitter until a `stop` or `error` event.
   *
   * NEEDS LIVE VALIDATION (ACP-NOTES §9d): Session resumption — the current
   * implementation disposes the `ActiveSession` after each turn, which means
   * a reconnecting SSE client that missed events cannot replay them.
   */
  async prompt(text: string): Promise<void> {
    if (this._disposed) throw new Error('AcpSession: already disposed');
    if (!this._session) throw new Error('AcpSession: no open session — call open() first');

    const session = this._session;
    log.debug('sending prompt (length=%d)', text.length);

    // If an orientation/grounding turn is still draining on the shared
    // `nextUpdate()` queue, wait for it to fully drain BEFORE starting the
    // user turn's drain — otherwise the two loops race over one queue and the
    // orientation leftovers bleed into the user turn.  Best-effort: swallow
    // its errors (already logged inside `_drainQuietly`).  Cleared after the
    // await so it's only awaited once.
    const grounding = this._groundingDrain;
    if (grounding) {
      this._groundingDrain = null;
      await grounding.catch(() => {
        /* grounding drain errors are non-fatal and already logged */
      });
    }

    // Fire-and-forget the update loop; the bridge controller reads from the
    // event emitter over SSE.
    void this._drainUpdates(session, text);
  }

  /**
   * Resolves a pending permission request.
   *
   * @param requestId - The `requestId` from the `permission_request` event.
   * @param optionId  - The chosen `optionId`, or `null` to auto-reject.
   */
  resolvePermission(requestId: string, optionId: string | null): void {
    const resolver = this._pendingPermissions.get(requestId);
    if (!resolver) {
      log.debug('resolvePermission: no pending request for id=%s', requestId);
      return;
    }
    resolver(optionId);
  }

  /**
   * Closes the session and the underlying ACP connection.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    log.debug('disposing AcpSession');

    // Reject all pending permission requests so their promises don't hang.
    for (const [, resolve] of this._pendingPermissions) {
      resolve(null);
    }
    this._pendingPermissions.clear();

    this._session?.dispose();
    this._connection?.close();
    // Kill the subprocess AFTER closing the connection (stdin EOF first so the
    // agent can flush, then SIGTERM ensures it actually exits).
    this._kill?.();
    this._session = null;
    this._connection = null;
    this._ctx = null;
    this._clientApp = null;
    this._kill = null;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Enforces the target permission mode on a freshly-opened session.
   *
   * If the agent advertised modes and the current mode is not the requested
   * `targetMode`, sends `session/set_mode` to switch to it.  Best-effort: a
   * failure is logged prominently (it means file edits may not be gated by the
   * dock's permission card) but never throws so the caller's `open()` flow is
   * not interrupted.
   *
   * If the agent did not advertise any modes (modes is null/undefined), a
   * warning is logged and we proceed — the permission gating is best-effort
   * when the adapter does not expose session mode state.
   */
  private async _enforcePermissionMode(
    sessionId: string,
    modes: SessionModeState | null | undefined,
    targetMode: string,
  ): Promise<void> {
    if (!modes) {
      log.warn(
        'AcpSession: agent did not advertise session modes — cannot enforce ' +
        'permission mode %s; file edits may be auto-accepted without prompting',
        targetMode,
      );
      return;
    }

    const {currentModeId, availableModes} = modes;

    if (currentModeId === targetMode) {
      log.debug('AcpSession: permission mode already %s — no set_mode needed', targetMode);
      return;
    }

    const hasTarget = availableModes.some(m => m.id === targetMode);
    if (!hasTarget) {
      log.warn(
        'AcpSession: target permission mode %s is not in advertised availableModes %o; ' +
        'cannot enforce prompting — file edits may be auto-accepted',
        targetMode,
        availableModes.map(m => m.id),
      );
      return;
    }

    try {
      log.debug(
        'AcpSession: switching permission mode from %s → %s (sessionId=%s)',
        currentModeId,
        targetMode,
        sessionId,
      );
      // ClientContext.request() is the typed gateway for all agent-side methods;
      // 'session/set_mode' is a recognised AgentRequestMethod so params and
      // response are fully typed.
      await this._ctx!.request('session/set_mode', {sessionId, modeId: targetMode});
      log.debug('AcpSession: permission mode set to %s', targetMode);
    } catch (err) {
      log.warn(
        'AcpSession: failed to set permission mode to %s — file edits may be auto-accepted without prompting. Error: %o',
        targetMode,
        err,
      );
    }
  }

  /**
   * Sends the prompt and drains `nextUpdate()` until stop or error, emitting
   * typed events on the emitter.
   */
  private async _drainUpdates(
    session: ActiveSession,
    text: string,
  ): Promise<void> {
    try {
      // `session.prompt()` queues the message AND a `stop` message in the
      // `nextUpdate()` queue.  We don't await the full PromptResponse here —
      // we let `nextUpdate()` drive the loop so SSE gets streaming chunks.
      void session.prompt(text);

      let done = false;
      while (!done && !this._disposed) {
        const msg: ActiveSessionMessage = await session.nextUpdate();

        if (msg.kind === 'stop') {
          this.emit('event', {
            type: 'stop',
            stopReason: msg.stopReason,
          } satisfies StopEvent);
          done = true;
        } else if (msg.kind === 'session_update') {
          this._dispatchUpdate(msg.update);
        }
      }
    } catch (err) {
      log.debug('AcpSession prompt drain error: %o', err);
      if (!this._disposed) {
        this.emit('event', {type: 'error', error: err} satisfies ErrorEvent);
      }
    }
  }

  /**
   * Sends a prompt and drains its turn QUIETLY — mirrors `_drainUpdates`'s
   * loop and stop-detection, but emits NOTHING on the public emitter (chunks
   * and the `stop` are swallowed, logged at debug only).
   *
   * Used for the orientation/grounding turn (`injectContext`): the ACP
   * `nextUpdate()` queue is shared per session, so the orientation turn must
   * be fully consumed off the queue before the first user turn's drain runs,
   * otherwise its leftovers bleed into the user turn.  Best-effort and
   * non-fatal — never throws (so `prompt()` can `await` it without a guard
   * beyond the `.catch()` it already has, and `dispose()` never hangs on it).
   */
  private async _drainQuietly(
    session: ActiveSession,
    text: string,
  ): Promise<void> {
    try {
      void session.prompt(text);

      let done = false;
      while (!done && !this._disposed) {
        const msg: ActiveSessionMessage = await session.nextUpdate();
        if (msg.kind === 'stop') {
          log.debug('grounding turn drained quietly (stopReason=%s)', msg.stopReason);
          done = true;
        }
        // session_update chunks (if any) are intentionally swallowed — the
        // orientation reply is background context, not user-visible output.
      }
    } catch (err) {
      // Non-fatal: the orientation turn is best-effort standing context.
      log.debug('grounding quiet-drain error (non-fatal): %o', err);
    }
  }

  /**
   * Maps a `SessionUpdate` union member to a typed `AcpEvent` and emits it.
   *
   * ACP `SessionUpdate` uses a `sessionUpdate` discriminant field (not `type`).
   * - `agent_message_chunk`: `ContentChunk` shape — `content` is a single
   *   `ContentBlock`, not an array.
   * - `tool_call`: `ToolCall` shape — has a nested `toolCall` object with
   *   `toolCallId`, `title`, `status`.
   */
  private _dispatchUpdate(update: unknown): void {
    const u = update as Record<string, unknown>;
    const kind = u['sessionUpdate'] as string | undefined;

    if (kind === 'agent_message_chunk') {
      // ContentChunk: content is a single ContentBlock (not array).
      const block = u['content'] as Record<string, unknown> | undefined;
      if (block && block['type'] === 'text' && typeof block['text'] === 'string') {
        this.emit('event', {
          type: 'assistant_delta',
          text: block['text'],
        } satisfies AssistantDeltaEvent);
      }
    } else if (kind === 'tool_call') {
      // ToolCall shape: the `toolCall` nested object has toolCallId/title/status.
      const toolCall = u['toolCallId']
        ? u // ToolCallUpdate shape is flat (fields directly on u)
        : (u['toolCall'] as Record<string, unknown> | undefined);
      if (toolCall) {
        this.emit('event', {
          type: 'tool_call',
          toolCallId: toolCall['toolCallId'] as string,
          title: toolCall['title'] as string | null | undefined,
          status: toolCall['status'] as string | null | undefined,
        } satisfies ToolCallEvent);
      }
    }
    // Other update types (plans, mode changes, etc.) are not forwarded to SSE
    // in this iteration.
  }
}
