// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/** Chat config shape — mirrors `ConsoleClientConfig['chat']` in the console shell. */
export interface ChatConfig {
  enabled: boolean;
  apiBase: string;
  agents: {id: string; name: string}[];
}

/**
 * Agent chat dock — placeholder for Phase 2 (Tasks 5/6).
 *
 * Renders the picker chrome, an empty conversation stream, and the composer
 * per the approved wireframe
 * (~/.gstack/projects/ninemindai-agentback/designs/agent-dock-20260620/
 * dock-wireframe.html).  No live SSE/ACP wiring yet — that is Tasks 5/6.
 */
export function Dock({chat}: {chat: ChatConfig}) {
  const firstAgent = chat.agents[0];

  return (
    <>
      <div className="dock-head">
        <div className="picker">
          <span className="dot off" />
          <span style={{minWidth: 0}}>
            <div className="dock-name">
              {firstAgent?.name ?? 'No agent'}
            </div>
            <div className="dock-adapter">
              {firstAgent ? 'claude-agent-acp · disconnected' : 'No agent discovered'}
            </div>
          </span>
        </div>
        <button className="ghost" aria-label="Agent options">⋯</button>
      </div>

      <div className="stream">
        {chat.agents.length === 0 && (
          <div className="dock-empty">
            <div className="dock-empty-title">No coding agent found</div>
            <div>Install one to chat with your app.</div>
            <code className="dock-install-hint">
              npm i -g @zed-industries/claude-agent-acp
            </code>
            <button
              className="ghost"
              style={{marginTop: '8px'}}
            >
              Re-check
            </button>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="inputrow">
          <input
            placeholder="Ask about or change this app…"
            aria-label="Chat message"
            disabled={chat.agents.length === 0}
          />
          <button
            className="send"
            aria-label="Send message"
            disabled={chat.agents.length === 0}
          >
            ↵
          </button>
        </div>
      </div>
    </>
  );
}
