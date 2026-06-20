// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Agent chat dock — full Phase 2 implementation.
 *
 * Renders the six interaction states from the approved wireframe:
 *   no-agent, connecting, doctor/wrong-version, streaming,
 *   crashed, rebuild (placeholder affordance for Task 7).
 *
 * Calls:
 *   GET  {apiBase}/agents
 *   POST {apiBase}/session   → {sessionId}
 *   GET  {apiBase}/stream?sessionId=… (SSE)
 *   POST {apiBase}/message   {sessionId, text, focus?}
 *   POST {apiBase}/permission {sessionId, requestId, optionId}
 *
 * Uses the focus bus from @agentback/console (`getFocus`, `subscribeFocus`)
 * to attach ambient context to outgoing messages.
 */

import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import {getFocus, subscribeFocus} from '@agentback/console/focus.js';
import type {FocusDescriptor} from '@agentback/console/focus.js';
import {
  openSseStream,
  turnReducer,
  initialConversationState,
} from './sse.js';
import type {
  ConversationMessage,
  PendingPermission,
  SseClientEvent,
} from './sse.js';

// ---------------------------------------------------------------------------
// Config shape (mirrors ConsoleClientConfig['chat'])
// ---------------------------------------------------------------------------

export interface ChatConfig {
  enabled: boolean;
  apiBase: string;
  agents: {id: string; name: string}[];
}

// ---------------------------------------------------------------------------
// Dock state machine
// ---------------------------------------------------------------------------

type DockStatus =
  | 'no-agent'
  | 'connecting'
  | 'doctor'
  | 'ready'
  | 'crashed'
  | 'rebuild';

interface DockState {
  status: DockStatus;
  selectedAgentId: string | null;
  sessionId: string | null;
  doctorMessage: string | null;
  crashMessage: string | null;
  availableAgents: {id: string; name: string}[];
  agentsLoaded: boolean;
}

type DockAction =
  | {type: 'agents_loaded'; agents: {id: string; name: string}[]}
  | {type: 'select_agent'; agentId: string}
  | {type: 'connecting'}
  | {type: 'connected'; sessionId: string}
  | {type: 'doctor'; message: string}
  | {type: 'crashed'; message: string}
  | {type: 'rebuild'}
  | {type: 'recheck'}
  | {type: 'restart'};

function dockReducer(state: DockState, action: DockAction): DockState {
  switch (action.type) {
    case 'agents_loaded':
      return {
        ...state,
        availableAgents: action.agents,
        agentsLoaded: true,
        // If agents are available and we are in no-agent state, auto-connect.
        status:
          action.agents.length === 0
            ? 'no-agent'
            : state.status === 'no-agent'
              ? 'connecting'
              : state.status,
        selectedAgentId:
          state.selectedAgentId ??
          (action.agents[0]?.id ?? null),
      };
    case 'select_agent':
      return {...state, selectedAgentId: action.agentId};
    case 'connecting':
      return {...state, status: 'connecting'};
    case 'connected':
      return {
        ...state,
        status: 'ready',
        sessionId: action.sessionId,
        crashMessage: null,
        doctorMessage: null,
      };
    case 'doctor':
      return {...state, status: 'doctor', doctorMessage: action.message};
    case 'crashed':
      return {
        ...state,
        status: 'crashed',
        crashMessage: action.message,
        sessionId: null,
      };
    case 'rebuild':
      return {...state, status: 'rebuild'};
    case 'recheck':
      return {...state, agentsLoaded: false, status: 'no-agent', availableAgents: []};
    case 'restart':
      return {
        ...state,
        status: 'connecting',
        sessionId: null,
        crashMessage: null,
      };
    default:
      return state;
  }
}

function initialDockState(initialAgents: {id: string; name: string}[]): DockState {
  const hasAgents = initialAgents.length > 0;
  return {
    status: hasAgents ? 'connecting' : 'no-agent',
    selectedAgentId: initialAgents[0]?.id ?? null,
    sessionId: null,
    doctorMessage: null,
    crashMessage: null,
    availableAgents: initialAgents,
    agentsLoaded: hasAgents,
  };
}

// ---------------------------------------------------------------------------
// Focus chip label helper
// ---------------------------------------------------------------------------

function focusLabel(f: FocusDescriptor): string {
  if (f.label) return f.label;
  switch (f.kind) {
    case 'schema-entity': return `schema: ${f.id}`;
    case 'binding': return `binding: ${f.id}`;
    case 'route': return `route: ${f.id}`;
    case 'tool': return `tool: ${f.id}`;
    default: return f.id;
  }
}

// ---------------------------------------------------------------------------
// Permission card detail line helper
// ---------------------------------------------------------------------------

function permDetailLine(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== 'object') return '';
  const tc = toolCall as Record<string, unknown>;
  const title = typeof tc['title'] === 'string' ? tc['title'] : '';
  return title;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolCallBlock({title, status}: {title: string | null; status: string | null}) {
  const label = title ?? 'tool';
  const statusStr = status ? ` (${status})` : '';
  return (
    <div className="tool">
      {'▸ '}<b>{label}</b>{statusStr}
    </div>
  );
}

function PermissionCard({
  perm,
  onApprove,
  onDeny,
  onScopeChange,
}: {
  perm: PendingPermission;
  onApprove: () => void;
  onDeny: () => void;
  onScopeChange: (checked: boolean) => void;
}) {
  const detail = permDetailLine(perm.toolCall);
  return (
    <div className="perm">
      <div className="q">Edit a file?</div>
      {detail && <div className="detail">{detail}</div>}
      <div className="acts">
        <button className="btn" onClick={onApprove} aria-label="Approve">
          Approve
        </button>
        <button className="btn ghost" onClick={onDeny} aria-label="Deny">
          Deny
        </button>
      </div>
      <div className="scope">
        <label>
          <input
            type="checkbox"
            checked={perm.scopeSession}
            onChange={e => onScopeChange(e.target.checked)}
            style={{verticalAlign: '-1px'}}
          />
          {' Allow edits in '}
          <span className="badge">{detail.split('/')[0] ?? 'src'}/</span>
          {' for this session'}
        </label>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  perm,
  onApprove,
  onDeny,
  onScopeChange,
}: {
  msg: ConversationMessage;
  perm: PendingPermission | null;
  onApprove: () => void;
  onDeny: () => void;
  onScopeChange: (checked: boolean) => void;
}) {
  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="who">you</div>
        <div className="bubble">{msg.text}</div>
      </div>
    );
  }

  return (
    <div className="msg assistant">
      <div className="who">agent</div>
      <div className="bubble">
        {msg.text && <span>{msg.text}</span>}
        {msg.toolCalls.map(tc => (
          <ToolCallBlock
            key={tc.toolCallId}
            title={tc.title}
            status={tc.status}
          />
        ))}
      </div>
      {perm && (
        <PermissionCard
          perm={perm}
          onApprove={onApprove}
          onDeny={onDeny}
          onScopeChange={onScopeChange}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

function Spin({size = 14}: {size?: number}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        border: '2px solid var(--line-2)',
        borderTopColor: 'var(--accent)',
        borderRadius: '50%',
        display: 'inline-block',
        animation: 'spin .8s linear infinite',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Main Dock component
// ---------------------------------------------------------------------------

export function Dock({
  chat,
  onToggleDock,
}: {
  chat: ChatConfig;
  dockOpen: boolean;
  onToggleDock: () => void;
}) {
  const {apiBase} = chat;

  // ── Dock-level state machine ──────────────────────────────────────────────
  const [dock, dispatchDock] = useReducer(
    dockReducer,
    chat.agents,
    initialDockState,
  );

  // ── Conversation state (pure reducer driven by SSE events) ────────────────
  const [conv, dispatchConv] = useReducer(
    turnReducer,
    undefined,
    initialConversationState,
  );

  // ── Focus chip ────────────────────────────────────────────────────────────
  const [focus, setFocus] = useState<FocusDescriptor | null>(() => getFocus());
  useEffect(() => {
    const unsub = subscribeFocus(setFocus);
    return unsub;
  }, []);
  const dismissFocus = useCallback(() => setFocus(null), []);

  // ── Composer input ────────────────────────────────────────────────────────
  const [inputText, setInputText] = useState('');
  const streamRef = useRef<HTMLDivElement | null>(null);

  // ── Pending permission (owned by conv state, updated here) ────────────────
  // conv.pendingPermission is the live pending perm; but the dock also needs to
  // know which message to attach it to (the last assistant message).
  const handleScopeChange = useCallback(
    (checked: boolean) => {
      if (!conv.pendingPermission) return;
      setScopeSession(checked);
    },
    [conv.pendingPermission],
  );
  const [scopeSession, setScopeSession] = useState(false);

  // ── Auto-scroll to bottom ─────────────────────────────────────────────────
  useEffect(() => {
    const el = streamRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [conv.messages.length, conv.status]);

  // ── Load agents (if not pre-populated) ───────────────────────────────────
  useEffect(() => {
    if (dock.agentsLoaded) return;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/agents`);
        if (!res.ok) return;
        const data = (await res.json()) as {agents: {id: string; name: string}[]};
        dispatchDock({type: 'agents_loaded', agents: data.agents});
      } catch {
        // Discovery failed; keep no-agent state.
      }
    })();
  }, [apiBase, dock.agentsLoaded]);

  // ── Start session when an agent is selected and no session exists ─────────
  useEffect(() => {
    if (
      dock.status !== 'connecting' ||
      !dock.selectedAgentId ||
      dock.sessionId
    ) return;
    const agentId = dock.selectedAgentId;
    void (async () => {
      try {
        const res = await fetch(`${apiBase}/session`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({agentId}),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {code?: string; message?: string};
          if (body.code === 'agent_handshake_failed') {
            dispatchDock({
              type: 'doctor',
              message: body.message ?? 'Handshake failed',
            });
          } else {
            dispatchDock({
              type: 'crashed',
              message: body.message ?? `Session creation failed (${res.status})`,
            });
          }
          return;
        }
        const {sessionId} = (await res.json()) as {sessionId: string};
        dispatchDock({type: 'connected', sessionId});
      } catch (err) {
        dispatchDock({
          type: 'crashed',
          message: err instanceof Error ? err.message : 'Failed to connect',
        });
      }
    })();
  }, [apiBase, dock.status, dock.selectedAgentId, dock.sessionId]);

  // ── SSE connection ────────────────────────────────────────────────────────
  useEffect(() => {
    if (dock.status !== 'ready' || !dock.sessionId) return;
    const url = `${apiBase}/stream?sessionId=${encodeURIComponent(dock.sessionId)}`;
    const cleanup = openSseStream(
      url,
      (ev: SseClientEvent) => {
        if (ev.type === 'server_restart') {
          // Server restarted (build:watch rebuild detected) — show rebuild affordance.
          dispatchDock({type: 'rebuild'});
          return;
        }
        if (ev.type === 'error') {
          dispatchDock({
            type: 'crashed',
            message:
              typeof (ev.error as Record<string, unknown> | null)?.message === 'string'
                ? ((ev.error as Record<string, unknown>).message as string)
                : 'Agent stopped unexpectedly',
          });
        }
        dispatchConv(ev);
      },
      () => {
        // SSE error (connection dropped after all retries) — treat as crash.
        dispatchDock({
          type: 'crashed',
          message: 'Connection to agent lost',
        });
      },
    );
    return cleanup;
  }, [apiBase, dock.status, dock.sessionId]);

  // ── Permssion resolve handler ─────────────────────────────────────────────
  const resolvePermission = useCallback(
    async (optionId: string | null) => {
      if (!conv.pendingPermission || !dock.sessionId) return;
      const {requestId} = conv.pendingPermission;
      setScopeSession(false);
      // Dispatch local resolved event before the POST so the UI responds immediately.
      dispatchConv({type: 'permission_resolved', requestId, optionId});
      try {
        await fetch(`${apiBase}/permission`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({sessionId: dock.sessionId, requestId, optionId}),
        });
      } catch {
        // Best-effort; the session will error if the resolution didn't land.
      }
    },
    [apiBase, conv.pendingPermission, dock.sessionId],
  );

  // ── Send message ──────────────────────────────────────────────────────────
  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !dock.sessionId) return;
    setInputText('');
    dispatchConv({type: 'user_message', text});
    const focusSnapshot = focus;
    setFocus(null); // consume the focus chip
    try {
      await fetch(`${apiBase}/message`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sessionId: dock.sessionId,
          text,
          ...(focusSnapshot ? {focus: focusSnapshot} : {}),
        }),
      });
    } catch {
      dispatchDock({type: 'crashed', message: 'Failed to send message'});
    }
  }, [apiBase, dock.sessionId, focus, inputText]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  // ── Agent name ────────────────────────────────────────────────────────────
  const agentName =
    dock.availableAgents.find(a => a.id === dock.selectedAgentId)?.name ??
    'Agent';

  // ── Dot status ────────────────────────────────────────────────────────────
  const dotClass = (() => {
    switch (dock.status) {
      case 'ready': return 'dot';
      case 'connecting': return 'dot warn';
      case 'crashed': return 'dot err';
      default: return 'dot off';
    }
  })();

  const adapterLabel = (() => {
    switch (dock.status) {
      case 'ready': return `${dock.selectedAgentId ?? 'agent'} · connected`;
      case 'connecting': return `${dock.selectedAgentId ?? 'agent'} · connecting…`;
      case 'doctor': return `${dock.selectedAgentId ?? 'agent'} · version mismatch`;
      case 'crashed': return `${dock.selectedAgentId ?? 'agent'} · stopped`;
      default: return 'no agent';
    }
  })();

  // ── Whether to disable the composer ──────────────────────────────────────
  const composerDisabled =
    dock.status !== 'ready' ||
    conv.status === 'awaiting_permission';

  // ── Find the last assistant message to attach the perm card to ────────────
  const permForLastAssistant: PendingPermission | null =
    conv.pendingPermission
      ? {...conv.pendingPermission, scopeSession}
      : null;

  const lastAssistantIdx = (() => {
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'assistant') return i;
    }
    return -1;
  })();

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      {/* Narrow-viewport tab (position:fixed via CSS; outside the dock flow) */}
      <button
        className="dock-tab"
        onClick={onToggleDock}
        aria-label="Toggle chat dock"
      >
        ▭ Chat
      </button>

      {/* Header */}
      <div className="dock-head">
          {dock.availableAgents.length > 1 ? (
            <div className="picker">
              <span className={dotClass} />
              <select
                value={dock.selectedAgentId ?? ''}
                onChange={e => dispatchDock({type: 'select_agent', agentId: e.target.value})}
                style={{
                  fontFamily: 'var(--sans)',
                  fontSize: '13px',
                  fontWeight: 600,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--ink)',
                  cursor: 'pointer',
                }}
                aria-label="Select agent"
              >
                {dock.availableAgents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <div className="dock-adapter">{adapterLabel}</div>
            </div>
          ) : (
            <div className="picker">
              <span className={dotClass} />
              <span style={{minWidth: 0}}>
                <div className="dock-name">{agentName}</div>
                <div className="dock-adapter">{adapterLabel}</div>
              </span>
            </div>
          )}
          <button
            className="ghost"
            aria-label="Agent options"
            title="Options"
          >
            ⋯
          </button>
        </div>

        {/* Stream / state body */}
        <div className="stream" ref={streamRef}>
          {/* State: no-agent */}
          {dock.status === 'no-agent' && (
            <div className="dock-empty">
              <div className="dock-empty-title">No coding agent found</div>
              <div>Install one to chat with your app.</div>
              <code className="dock-install-hint">
                npm i -g claude-agent-acp
              </code>
              <button
                className="btn"
                style={{marginTop: '8px'}}
                onClick={() => dispatchDock({type: 'recheck'})}
              >
                Re-check
              </button>
            </div>
          )}

          {/* State: connecting */}
          {dock.status === 'connecting' && (
            <div className="dock-empty">
              <Spin size={16} />
              <div>
                Launching{' '}
                <span className="badge">{dock.selectedAgentId ?? 'agent'}</span>
                …
              </div>
              <div style={{color: 'var(--faint)', fontSize: '11px'}}>
                handshake
              </div>
            </div>
          )}

          {/* State: doctor / wrong version */}
          {dock.status === 'doctor' && (
            <div className="dock-empty">
              <div
                className="dock-empty-title"
                style={{color: 'var(--accent)'}}
              >
                Adapter out of date
              </div>
              <div style={{fontSize: '12.5px', color: 'var(--muted)'}}>
                {dock.doctorMessage ?? 'Version mismatch.'}
              </div>
              <code className="dock-install-hint">
                npm i -g claude-agent-acp@latest
              </code>
              <button
                className="btn"
                style={{marginTop: '8px'}}
                onClick={() => dispatchDock({type: 'restart'})}
              >
                Retry
              </button>
            </div>
          )}

          {/* State: crashed */}
          {dock.status === 'crashed' && (
            <div className="dock-empty">
              <div
                className="dock-empty-title"
                style={{color: 'var(--err)'}}
              >
                Agent stopped
              </div>
              <div style={{fontSize: '12.5px'}}>
                {dock.crashMessage ?? 'The session ended unexpectedly.'}
              </div>
              <div style={{display: 'flex', gap: '8px', marginTop: '8px'}}>
                <button
                  className="btn"
                  onClick={() => dispatchDock({type: 'restart'})}
                >
                  Restart
                </button>
                <button className="btn ghost">
                  View log
                </button>
              </div>
            </div>
          )}

          {/* State: rebuild (F5) */}
          {dock.status === 'rebuild' && (
            <div className="dock-empty">
              <div>Edited files.</div>
              <div className="dock-empty-title">Rebuild to see changes live</div>
              <button
                className="btn"
                style={{marginTop: '8px'}}
                onClick={() => {
                  // Placeholder: Task 7 wires the real rebuild + reconnect.
                  dispatchDock({type: 'restart'});
                }}
              >
                Rebuild &amp; reconnect
              </button>
              <div style={{color: 'var(--faint)', fontSize: '11px'}}>
                watch build detected
              </div>
            </div>
          )}

          {/* Conversation messages (ready state) */}
          {(dock.status === 'ready' || conv.messages.length > 0) &&
            dock.status !== 'no-agent' &&
            dock.status !== 'connecting' &&
            dock.status !== 'doctor' &&
            dock.status !== 'rebuild' &&
            conv.messages.map((msg, idx) => {
              const isPerm = idx === lastAssistantIdx;
              return (
                <MessageBubble
                  key={idx}
                  msg={msg}
                  perm={isPerm ? permForLastAssistant : null}
                  onApprove={() => void resolvePermission(
                    conv.pendingPermission?.options[0]?.optionId ?? 'allow_once',
                  )}
                  onDeny={() => void resolvePermission(null)}
                  onScopeChange={handleScopeChange}
                />
              );
            })
          }

          {/* Inline streaming indicator */}
          {dock.status === 'ready' && conv.status === 'streaming' && (
            <div style={{paddingLeft: '4px'}}>
              <Spin size={11} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="composer">
          {focus && (
            <span className="chip">
              {focusLabel(focus)}
              <span className="x" onClick={dismissFocus} role="button" aria-label="Dismiss context">
                ×
              </span>
            </span>
          )}
          <div className="inputrow">
            <input
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Ask about or change this app…"
              aria-label="Chat message"
              disabled={composerDisabled}
            />
            <button
              className="send"
              aria-label="Send message"
              disabled={composerDisabled || !inputText.trim()}
              onClick={() => void sendMessage()}
            >
              ↵
            </button>
          </div>
        </div>

      {/* Spin keyframe (injected once) */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </>
  );
}
