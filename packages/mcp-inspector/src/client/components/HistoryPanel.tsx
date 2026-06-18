// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import type {HistoryEntry} from '../api';
import {OutcomeView} from './JsonView';

export function HistoryPanel({
  entries,
  onClose,
}: {
  entries: HistoryEntry[];
  onClose: () => void;
}) {
  return (
    <aside className="history">
      <button className="ghost close" onClick={onClose}>
        close
      </button>
      <h2>History</h2>
      {entries.length === 0 ? (
        <p className="empty">No invocations yet.</p>
      ) : (
        entries.map(e => (
          <details key={e.id} className="hentry">
            <summary>
              <span className="top">
                <span className="badge">{e.kind}</span>
                <span className="name">{e.name}</span>
                <span className={e.outcome.ok ? 'ok' : 'bad'}>
                  {e.outcome.ok ? 'ok' : 'fail'}
                </span>
                <time>{e.at}</time>
              </span>
            </summary>
            <OutcomeView outcome={e.outcome} />
          </details>
        ))
      )}
    </aside>
  );
}
