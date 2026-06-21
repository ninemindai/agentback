// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Unit tests for the pure `turnReducer` in `sse.ts`.
 *
 * These are pure-function tests — no DOM, no React, no EventSource.
 * The reducer is the unit-testable core of the SSE streaming state machine.
 */

import {describe, it, expect} from 'vitest';
import {
  turnReducer,
  initialConversationState,
  type ConversationState,
  type SseClientEvent,
} from '../../client/sse.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyAll(
  events: SseClientEvent[],
  initial: ConversationState = initialConversationState(),
): ConversationState {
  return events.reduce(turnReducer, initial);
}

// ---------------------------------------------------------------------------
// 1. Happy path: assistant_delta × 2 → tool_call → permission_request
//    → permission resolved (stop) → stop
// ---------------------------------------------------------------------------

describe('turnReducer: happy-path sequence', () => {
  it('folds assistant_delta events into message text', () => {
    const events: SseClientEvent[] = [
      {type: 'assistant_delta', text: 'Hello '},
      {type: 'assistant_delta', text: 'world'},
    ];
    const state = applyAll(events);

    expect(state.status).toBe('streaming');
    expect(state.messages.length).toBe(1);
    const msg = state.messages[0];
    expect(msg.role).toBe('assistant');
    expect(msg.text).toBe('Hello world');
    expect(state.pendingPermission).toBeNull();
    expect(state.error).toBeNull();
  });

  it('appends a tool_call block after assistant text', () => {
    const events: SseClientEvent[] = [
      {type: 'assistant_delta', text: 'Let me check.'},
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        title: 'inventory',
        status: 'running',
      },
    ];
    const state = applyAll(events);

    expect(state.status).toBe('streaming');
    expect(state.messages.length).toBe(1);
    const msg = state.messages[0];
    // The tool call is recorded in toolCalls
    expect(msg.toolCalls.length).toBe(1);
    expect(msg.toolCalls[0].toolCallId).toBe('tc-1');
    expect(msg.toolCalls[0].title).toBe('inventory');
  });

  it('merges tool_call updates: one row, title preserved when update omits it', () => {
    // ACP sends the title on the initial tool_call and omits it on the
    // completion update. The reducer must keep ONE row and NOT wipe the title
    // to null (else every row renders as the fallback "tool").
    const events: SseClientEvent[] = [
      {type: 'tool_call', toolCallId: 'tc-1', title: 'inventory', status: 'pending'},
      {type: 'tool_call', toolCallId: 'tc-1', title: undefined, status: undefined},
      {type: 'tool_call', toolCallId: 'tc-1', title: undefined, status: 'completed'},
    ];
    const msg = applyAll(events).messages.at(-1)!;
    expect(msg.toolCalls.length).toBe(1); // upsert, not append
    expect(msg.toolCalls[0].title).toBe('inventory'); // preserved
    expect(msg.toolCalls[0].status).toBe('completed'); // resolved
  });

  it('keeps distinct tool calls as distinct rows', () => {
    const events: SseClientEvent[] = [
      {type: 'tool_call', toolCallId: 'a', title: 'inventory', status: 'pending'},
      {type: 'tool_call', toolCallId: 'b', title: 'get', status: 'pending'},
      {type: 'tool_call', toolCallId: 'a', title: undefined, status: 'completed'},
      {type: 'tool_call', toolCallId: 'b', title: undefined, status: 'completed'},
    ];
    const rows = applyAll(events).messages.at(-1)!.toolCalls;
    expect(rows.map(r => `${r.title}:${r.status}`)).toEqual([
      'inventory:completed',
      'get:completed',
    ]);
  });

  it('surfaces a permission_request as pendingPermission', () => {
    const events: SseClientEvent[] = [
      {type: 'assistant_delta', text: 'About to edit.'},
      {
        type: 'permission_request',
        requestId: 'req-1',
        toolCall: {toolCallId: 'tc-2', kind: 'file_edit', title: 'Edit src/greeting.ts'},
        options: [
          {optionId: 'allow_once', kind: 'allow_once', label: 'Allow once'},
          {optionId: 'reject_once', kind: 'reject_once', label: 'Reject once'},
        ],
      },
    ];
    const state = applyAll(events);

    expect(state.status).toBe('awaiting_permission');
    expect(state.pendingPermission).not.toBeNull();
    expect(state.pendingPermission!.requestId).toBe('req-1');
    expect(state.pendingPermission!.options.length).toBe(2);
    expect(state.pendingPermission!.options[0].label).toBe('Allow once');
  });

  it('clears pendingPermission and resumes streaming on permission_resolved', () => {
    const events: SseClientEvent[] = [
      {type: 'assistant_delta', text: 'Editing...'},
      {
        type: 'permission_request',
        requestId: 'req-2',
        toolCall: {},
        options: [{optionId: 'allow', kind: 'allow_once', label: 'Allow'}],
      },
      {type: 'permission_resolved', requestId: 'req-2', optionId: 'allow'},
    ];
    const state = applyAll(events);

    expect(state.pendingPermission).toBeNull();
    // Status may be streaming (more deltas could arrive) or stopped if stop
    // was not emitted yet — here it should be 'streaming' (no stop yet).
    expect(state.status).toBe('streaming');
  });

  it('transitions to stopped on stop event', () => {
    const events: SseClientEvent[] = [
      {type: 'assistant_delta', text: 'Done.'},
      {type: 'stop', stopReason: 'end_turn'},
    ];
    const state = applyAll(events);

    expect(state.status).toBe('stopped');
    expect(state.stopReason).toBe('end_turn');
    expect(state.messages[0].text).toBe('Done.');
  });

  it('full sequence: delta ×2, tool_call, permission, resolved, stop', () => {
    const events: SseClientEvent[] = [
      {type: 'assistant_delta', text: 'Let me check '},
      {type: 'assistant_delta', text: 'the schema.'},
      {type: 'tool_call', toolCallId: 'tc-3', title: 'inventory', status: 'running'},
      {
        type: 'permission_request',
        requestId: 'req-3',
        toolCall: {kind: 'file_edit'},
        options: [{optionId: 'allow', kind: 'allow_once', label: 'Allow once'}],
      },
      {type: 'permission_resolved', requestId: 'req-3', optionId: 'allow'},
      {type: 'stop', stopReason: 'end_turn'},
    ];
    const state = applyAll(events);

    expect(state.status).toBe('stopped');
    expect(state.stopReason).toBe('end_turn');
    expect(state.pendingPermission).toBeNull();
    expect(state.messages[0].text).toBe('Let me check the schema.');
    expect(state.messages[0].toolCalls.length).toBe(1);
    expect(state.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Error event → crashed state
// ---------------------------------------------------------------------------

describe('turnReducer: error event', () => {
  it('transitions to crashed on error event', () => {
    const events: SseClientEvent[] = [
      {type: 'assistant_delta', text: 'Working...'},
      {type: 'error', error: {message: 'Agent process died'}},
    ];
    const state = applyAll(events);

    expect(state.status).toBe('crashed');
    expect(state.error).not.toBeNull();
    expect(state.error!.message).toBe('Agent process died');
    // Partial text is preserved.
    expect(state.messages[0].text).toBe('Working...');
  });

  it('error on empty conversation yields crashed state with no messages', () => {
    const state = applyAll([{type: 'error', error: {message: 'Spawn failed'}}]);

    expect(state.status).toBe('crashed');
    expect(state.error).not.toBeNull();
    expect(state.messages.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. User message is appended to messages
// ---------------------------------------------------------------------------

describe('turnReducer: user_message', () => {
  it('appends a user message', () => {
    const state = applyAll([
      {type: 'user_message', text: 'Add an updatedAt field.'},
      {type: 'assistant_delta', text: 'Sure, let me do that.'},
    ]);

    expect(state.messages.length).toBe(2);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[0].text).toBe('Add an updatedAt field.');
    expect(state.messages[1].role).toBe('assistant');
    expect(state.messages[1].text).toBe('Sure, let me do that.');
  });
});

// ---------------------------------------------------------------------------
// 4. Multiple turns: new user message starts a new assistant message
// ---------------------------------------------------------------------------

describe('turnReducer: multi-turn', () => {
  it('second user_message starts a fresh assistant message slot', () => {
    const events: SseClientEvent[] = [
      {type: 'user_message', text: 'Turn 1'},
      {type: 'assistant_delta', text: 'Reply 1'},
      {type: 'stop', stopReason: 'end_turn'},
      {type: 'user_message', text: 'Turn 2'},
      {type: 'assistant_delta', text: 'Reply 2'},
      {type: 'stop', stopReason: 'end_turn'},
    ];
    const state = applyAll(events);

    expect(state.messages.length).toBe(4);
    expect(state.messages[0].text).toBe('Turn 1');
    expect(state.messages[1].text).toBe('Reply 1');
    expect(state.messages[2].text).toBe('Turn 2');
    expect(state.messages[3].text).toBe('Reply 2');
  });
});

// ---------------------------------------------------------------------------
// 5. tool_call upsert: same toolCallId → one entry updated, not two
// ---------------------------------------------------------------------------

describe('turnReducer: tool_call upsert', () => {
  it('two tool_call events with the same toolCallId produce one entry (updated)', () => {
    const events: SseClientEvent[] = [
      {type: 'assistant_delta', text: 'Working…'},
      {type: 'tool_call', toolCallId: 'tc-dup', title: 'write_file', status: 'running'},
      {type: 'tool_call', toolCallId: 'tc-dup', title: 'write_file', status: 'done'},
    ];
    const state = applyAll(events);

    expect(state.messages.length).toBe(1);
    const msg = state.messages[0];
    expect(msg.toolCalls.length).toBe(1);
    expect(msg.toolCalls[0].toolCallId).toBe('tc-dup');
    expect(msg.toolCalls[0].status).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// 6. initialConversationState shape
// ---------------------------------------------------------------------------

describe('initialConversationState', () => {
  it('returns a clean slate', () => {
    const s = initialConversationState();
    expect(s.status).toBe('idle');
    expect(s.messages).toEqual([]);
    expect(s.pendingPermission).toBeNull();
    expect(s.error).toBeNull();
    expect(s.stopReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. server_restart event is a no-op in the turn reducer
// ---------------------------------------------------------------------------

describe('turnReducer: server_restart (F5)', () => {
  it('server_restart event does not change conversation state', () => {
    const initial = applyAll([
      {type: 'assistant_delta', text: 'Working on it...'},
    ]);
    const after = turnReducer(initial, {type: 'server_restart'});

    // State must be unchanged.
    expect(after).toBe(initial);
    expect(after.messages[0].text).toBe('Working on it...');
    expect(after.status).toBe('streaming');
  });
});
