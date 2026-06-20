// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * SSE client + pure `turnReducer` for the agent dock.
 *
 * `turnReducer(state, event): state` folds the SSE event stream from
 * `/console/chat/stream` into conversation state.  It is deliberately
 * free of DOM/React so it can be unit-tested without a browser environment.
 *
 * `openSseStream(url, onEvent, onError)` manages the real `EventSource`
 * lifecycle (reconnect on drop; returns a cleanup fn).
 */

// ---------------------------------------------------------------------------
// SSE event shapes (client-side view of AcpEvent + client-local events)
// ---------------------------------------------------------------------------

/** An assistant token delivered by the bridge. */
export interface SseAssistantDelta {
  type: 'assistant_delta';
  text: string;
}

/** A tool-call activity update. */
export interface SseToolCall {
  type: 'tool_call';
  toolCallId: string;
  title?: string | null;
  status?: string | null;
}

/** A permission prompt from the agent. */
export interface SsePermissionRequest {
  type: 'permission_request';
  requestId: string;
  toolCall: unknown;
  options: Array<{optionId: string; kind: string; label?: string}>;
}

/** Client-local event: the user resolved a pending permission request. */
export interface SsePermissionResolved {
  type: 'permission_resolved';
  requestId: string;
  optionId: string | null;
}

/** Turn finished. */
export interface SseStop {
  type: 'stop';
  stopReason: string;
}

/** Session-level error or agent crash. */
export interface SseError {
  type: 'error';
  error: {message?: string; [k: string]: unknown};
}

/** Client-local event: user sent a message (injected into state for rendering). */
export interface SseUserMessage {
  type: 'user_message';
  text: string;
}

/** Heartbeat — ignored by the reducer. */
export interface SseHeartbeat {
  type: 'heartbeat';
}

export type SseClientEvent =
  | SseAssistantDelta
  | SseToolCall
  | SsePermissionRequest
  | SsePermissionResolved
  | SseStop
  | SseError
  | SseUserMessage
  | SseHeartbeat;

// ---------------------------------------------------------------------------
// Conversation state
// ---------------------------------------------------------------------------

export interface ToolCallEntry {
  toolCallId: string;
  title: string | null;
  status: string | null;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
  /** Tool calls that appeared during this assistant turn (empty for user msgs). */
  toolCalls: ToolCallEntry[];
}

export interface PendingPermission {
  requestId: string;
  toolCall: unknown;
  options: Array<{optionId: string; kind: string; label?: string}>;
  /** Whether the user has checked the "allow for session" scope checkbox. */
  scopeSession: boolean;
}

export type ConversationStatus =
  | 'idle'
  | 'streaming'
  | 'awaiting_permission'
  | 'stopped'
  | 'crashed';

export interface ConversationState {
  status: ConversationStatus;
  messages: ConversationMessage[];
  pendingPermission: PendingPermission | null;
  error: {message: string; [k: string]: unknown} | null;
  stopReason: string | null;
}

/** Returns a clean initial state. */
export function initialConversationState(): ConversationState {
  return {
    status: 'idle',
    messages: [],
    pendingPermission: null,
    error: null,
    stopReason: null,
  };
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

/**
 * Folds one SSE event into the conversation state.
 *
 * Rules:
 * - `assistant_delta` events are appended to the last assistant message (or
 *   a new one is created).  Status → 'streaming'.
 * - `tool_call` events are recorded against the current (last) assistant
 *   message's toolCalls array.
 * - `permission_request` → status 'awaiting_permission' + pendingPermission.
 * - `permission_resolved` clears pendingPermission → 'streaming'.
 * - `stop` → status 'stopped' + stopReason.
 * - `error` → status 'crashed' + error.
 * - `user_message` appends a user message, resets status to 'streaming'.
 * - `heartbeat` is a no-op (returns state unchanged).
 */
export function turnReducer(
  state: ConversationState,
  event: SseClientEvent,
): ConversationState {
  switch (event.type) {
    case 'heartbeat':
      return state;

    case 'user_message': {
      const userMsg: ConversationMessage = {
        role: 'user',
        text: event.text,
        toolCalls: [],
      };
      return {
        ...state,
        status: 'streaming',
        messages: [...state.messages, userMsg],
        error: null,
        stopReason: null,
      };
    }

    case 'assistant_delta': {
      const msgs = state.messages;
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') {
        // Append to the existing assistant message.
        const updated: ConversationMessage = {
          ...last,
          text: last.text + event.text,
        };
        return {
          ...state,
          status: 'streaming',
          messages: [...msgs.slice(0, -1), updated],
        };
      }
      // Start a new assistant message.
      const newMsg: ConversationMessage = {
        role: 'assistant',
        text: event.text,
        toolCalls: [],
      };
      return {
        ...state,
        status: 'streaming',
        messages: [...msgs, newMsg],
      };
    }

    case 'tool_call': {
      const msgs = state.messages;
      const last = msgs[msgs.length - 1];
      const entry: ToolCallEntry = {
        toolCallId: event.toolCallId,
        title: event.title ?? null,
        status: event.status ?? null,
      };
      if (last && last.role === 'assistant') {
        // Check if we're updating an existing tool call entry.
        const existingIdx = last.toolCalls.findIndex(
          tc => tc.toolCallId === event.toolCallId,
        );
        let toolCalls: ToolCallEntry[];
        if (existingIdx >= 0) {
          toolCalls = [
            ...last.toolCalls.slice(0, existingIdx),
            entry,
            ...last.toolCalls.slice(existingIdx + 1),
          ];
        } else {
          toolCalls = [...last.toolCalls, entry];
        }
        const updated: ConversationMessage = {...last, toolCalls};
        return {
          ...state,
          status: 'streaming',
          messages: [...msgs.slice(0, -1), updated],
        };
      }
      // No current assistant message — create one just for the tool call.
      const newMsg: ConversationMessage = {
        role: 'assistant',
        text: '',
        toolCalls: [entry],
      };
      return {
        ...state,
        status: 'streaming',
        messages: [...msgs, newMsg],
      };
    }

    case 'permission_request': {
      const perm: PendingPermission = {
        requestId: event.requestId,
        toolCall: event.toolCall,
        options: event.options,
        scopeSession: false,
      };
      return {
        ...state,
        status: 'awaiting_permission',
        pendingPermission: perm,
      };
    }

    case 'permission_resolved': {
      if (
        state.pendingPermission &&
        state.pendingPermission.requestId === event.requestId
      ) {
        return {
          ...state,
          status: 'streaming',
          pendingPermission: null,
        };
      }
      return state;
    }

    case 'stop': {
      return {
        ...state,
        status: 'stopped',
        stopReason: event.stopReason,
        pendingPermission: null,
      };
    }

    case 'error': {
      const err = event.error ?? {};
      return {
        ...state,
        status: 'crashed',
        error: {
          message: typeof err.message === 'string' ? err.message : 'Unknown error',
          ...err,
        },
        pendingPermission: null,
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// EventSource client
// ---------------------------------------------------------------------------

// Minimal EventSource interface for environments where the browser type is
// not available (Node/tsc compile target).  The real `EventSource` at runtime
// (browser) satisfies this shape; the type cast below is safe.
interface MinimalEventSource {
  onmessage: ((ev: {data: unknown}) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

/**
 * Opens an SSE stream against `url` and calls `onEvent` for each parsed
 * data frame.  Returns a cleanup function that closes the connection.
 *
 * The caller is responsible for reconnecting on connection loss; this
 * function focuses on the framing + error signal only.
 *
 * This function must only be called in a browser context (requires
 * `globalThis.EventSource`).
 */
export function openSseStream(
  url: string,
  onEvent: (ev: SseClientEvent) => void,
  onError?: (err: unknown) => void,
): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const EventSourceCtor = (globalThis as any).EventSource as new(
    url: string,
  ) => MinimalEventSource;
  const es = new EventSourceCtor(url);

  es.onmessage = (ev: {data: unknown}) => {
    try {
      const parsed = JSON.parse(ev.data as string) as SseClientEvent;
      onEvent(parsed);
    } catch {
      // Malformed frame — ignore.
    }
  };

  if (onError) {
    es.onerror = onError;
  }

  return () => es.close();
}
