// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingNode} from '../api';

interface Props {
  binding: BindingNode | null;
  /** Keys this binding injects (depends on). */
  dependsOn: string[];
  /** Keys that inject this binding (depend on it). */
  dependedOnBy: string[];
  /** config keys configuring THIS binding (target side). */
  configuredBy: string[];
  /** extensions contributing to THIS point (if it is an extension point). */
  extensions: string[];
  /** other bindings sharing this binding's source class (dual registration). */
  siblings: string[];
  onSelect: (key: string) => void;
}

/** Right pane: full metadata for the selected binding plus its wiring. */
export function BindingDetail({
  binding,
  dependsOn,
  dependedOnBy,
  configuredBy,
  extensions,
  siblings,
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
  if (binding.kinds.length) rows.push(['Kinds', binding.kinds.join(', ')]);
  rows.push([
    'Tags',
    binding.tags.length
      ? binding.tags
          .map(t => (t.value === true ? t.name : `${t.name}=${t.value}`))
          .join(', ')
      : '—',
  ]);
  if (binding.extensionPoint) {
    rows.push(['Extension point', binding.extensionPoint]);
  }
  if (binding.extensionFor?.length) {
    rows.push(['Extends', binding.extensionFor.join(', ')]);
  }
  if (binding.configurationFor) {
    rows.push(['Configures', binding.configurationFor]);
  }
  if (binding.lifeCycleGroup) {
    rows.push(['Lifecycle group', binding.lifeCycleGroup]);
  }
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
      {siblings.length > 0 && (
        <DepList
          title="Sibling registration"
          keys={siblings}
          onSelect={onSelect}
        />
      )}
      <DepList title="Depends on" keys={dependsOn} onSelect={onSelect} />
      <DepList title="Depended on by" keys={dependedOnBy} onSelect={onSelect} />
      {binding.extensionPoint && (
        <DepList title="Extensions" keys={extensions} onSelect={onSelect} />
      )}
      <DepList title="Configured by" keys={configuredBy} onSelect={onSelect} />
      {binding.routes?.length ? <RouteList routes={binding.routes} /> : null}
      {binding.tools?.length ? <ToolList tools={binding.tools} /> : null}
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

function RouteList({routes}: {routes: NonNullable<BindingNode['routes']>}) {
  return (
    <section className="deps">
      <h3>
        Routes <span className="count">({routes.length})</span>
      </h3>
      <ul>
        {routes.map(r => (
          <li key={`${r.verb} ${r.path}`}>
            <code>
              {r.verb} {r.path}
            </code>
          </li>
        ))}
      </ul>
      <a className="dep" href="/explorer" target="_blank" rel="noreferrer">
        open in API explorer ↗
      </a>
    </section>
  );
}

function ToolList({tools}: {tools: NonNullable<BindingNode['tools']>}) {
  return (
    <section className="deps">
      <h3>
        Tools <span className="count">({tools.length})</span>
      </h3>
      <ul>
        {tools.map(t => (
          <li key={t.name}>
            <code>{t.name}</code>
            {t.description ? ` — ${t.description}` : ''}
          </li>
        ))}
      </ul>
      <a className="dep" href="/mcp-inspector" target="_blank" rel="noreferrer">
        open in MCP inspector ↗
      </a>
    </section>
  );
}
