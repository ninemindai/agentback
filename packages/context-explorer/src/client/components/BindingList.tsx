// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingSummary} from '../api';

interface Props {
  bindings: BindingSummary[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onTag: (tag: string) => void;
}

/** Left pane: a scrollable list of binding rows with scope/type/tag badges. */
export function BindingList({bindings, selectedKey, onSelect, onTag}: Props) {
  if (bindings.length === 0) {
    return <p className="empty">No bindings match.</p>;
  }
  return (
    <>
      {bindings.map(b => (
        <button
          key={b.context + '|' + b.key}
          className={'row' + (b.key === selectedKey ? ' sel' : '')}
          onClick={() => onSelect(b.key)}
        >
          <div className="key">{b.key}</div>
          <div className="meta">
            <span className="badge">{b.scope}</span>
            {b.type && <span className="badge">{b.type}</span>}
            {b.tags.map(t => (
              <span
                key={t}
                className="badge tag"
                onClick={e => {
                  e.stopPropagation();
                  onTag(t);
                }}
              >
                {t}
              </span>
            ))}
          </div>
        </button>
      ))}
    </>
  );
}
