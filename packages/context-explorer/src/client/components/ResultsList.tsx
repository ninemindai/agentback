// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingNode} from '../api';
import {slug} from '../../lib/slug';

interface Props {
  bindings: BindingNode[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

export function ResultsList({bindings, selectedKey, onSelect}: Props) {
  if (bindings.length === 0) return <p className="empty">No bindings match.</p>;
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
            <span className={'badge scope-' + slug(b.scope)}>{b.scope}</span>
            {b.type && (
              <span className={'badge type-' + slug(b.type)}>{b.type}</span>
            )}
            {b.kinds.map(k => (
              <span key={k} className="kindtag">
                {k}
              </span>
            ))}
            {b.tags.map(t => (
              <span key={t.name} className="badge tag">
                {t.value === true ? t.name : `${t.name}=${t.value}`}
              </span>
            ))}
          </div>
        </button>
      ))}
    </>
  );
}
