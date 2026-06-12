// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingSummary} from '../api';

interface Props {
  binding: BindingSummary | null;
  /** Keys this binding injects (depends on). */
  dependsOn: string[];
  /** Keys that inject this binding (depend on it). */
  dependedOnBy: string[];
  onSelect: (key: string) => void;
}

/** Right pane: full metadata for the selected binding plus its dependencies. */
export function BindingDetail({
  binding,
  dependsOn,
  dependedOnBy,
  onSelect,
}: Props) {
  if (!binding) {
    return <p className="empty">Select a binding to see its details.</p>;
  }
  const rows: [string, string][] = [
    ['Key', binding.key],
    ['Context', binding.context],
    ['Scope', binding.scope],
  ];
  if (binding.type) rows.push(['Type', binding.type]);
  if (binding.source) rows.push(['Source', binding.source]);
  rows.push(['Tags', binding.tags.length ? binding.tags.join(', ') : '—']);
  if (binding.isLocked !== undefined) {
    rows.push(['Locked', String(binding.isLocked)]);
  }
  return (
    <>
      <h2>{binding.key}</h2>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} style={{display: 'contents'}}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <DepList title="Depends on" keys={dependsOn} onSelect={onSelect} />
      <DepList title="Depended on by" keys={dependedOnBy} onSelect={onSelect} />
    </>
  );
}

function DepList({
  title,
  keys,
  onSelect,
}: {
  title: string;
  keys: string[];
  onSelect: (key: string) => void;
}) {
  return (
    <section className="deps">
      <h3>
        {title} <span className="count">({keys.length})</span>
      </h3>
      {keys.length === 0 ? (
        <p className="empty">none</p>
      ) : (
        <ul>
          {keys.map(k => (
            <li key={k}>
              <button className="dep" onClick={() => onSelect(k)}>
                {k}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
