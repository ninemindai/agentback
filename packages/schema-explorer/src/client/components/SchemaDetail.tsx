// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {useState} from 'react';
import type {SchemaNode, SchemaUsage} from '../api';
import {EntityCard} from './EntityCard';
import type {JSchema} from '../lib/jsonschema';

interface Props {
  node: SchemaNode;
}

type SchemaView = 'fields' | 'json';

// Does the surface CONSUME the schema (in) or PRODUCE it (out)? Drives the
// directional glyph in the provenance ledger.
const DIRECTION: Record<string, 'in' | 'out'> = {
  body: 'in',
  input: 'in',
  path: 'in',
  query: 'in',
  headers: 'in',
  response: 'out',
  output: 'out',
  stream: 'out',
};

function UsageRow({u}: {u: SchemaUsage}) {
  const dir = DIRECTION[u.role] ?? 'in';
  return (
    <li className={'use ' + u.surface}>
      <span className={'umark ' + u.surface}>{u.surface}</span>
      <span className="ref">{u.ref}</span>
      <span className={'role ' + dir}>
        <span className="arrow">{dir === 'out' ? '↗' : '↘'}</span>
        {u.role}
      </span>
    </li>
  );
}

/**
 * Per-entity detail, set like a reference-book entry: a Fraunces masthead, a
 * provenance ledger (where the schema is used across REST + MCP + DB — the
 * cross-protocol payoff), and the emitted schema as either a typeset field
 * table or raw JSON. Registered schemas nothing uses are flagged as dead.
 */
export function SchemaDetail({node}: Props) {
  const [schemaView, setSchemaView] = useState<SchemaView>('fields');

  return (
    <>
      <header className="entryhead">
        <div className="eyebrow">
          {node.bound ? 'Registered entity' : 'Discovered schema'}
          {node.fieldCount != null && (
            <span className="fcount"> · {node.fieldCount} fields</span>
          )}
        </div>
        <h2>{node.name}</h2>
        <div className="meta">
          {node.bindingKey && <span className="mkey">{node.bindingKey}</span>}
          {node.origin?.table && (
            <span className="mtag">
              <span className="g">⛁</span>
              {node.origin.table}
              {node.origin.kind && <em> · {node.origin.kind}</em>}
            </span>
          )}
        </div>
      </header>

      <section className="uses">
        <h3>Used by</h3>
        {node.usages.length === 0 ? (
          <div className="deadnote">
            Not bound to any route or tool — a registered schema nothing uses.
          </div>
        ) : (
          <ul>
            {node.usages.map((u, i) => (
              <UsageRow key={i} u={u} />
            ))}
          </ul>
        )}
      </section>

      <section className="fields">
        <div className="fieldhead">
          <h3>Schema</h3>
          {node.jsonSchema != null && (
            <div className="seg" role="tablist">
              <button
                className={schemaView === 'fields' ? 'on' : ''}
                onClick={() => setSchemaView('fields')}
              >
                Fields
              </button>
              <button
                className={schemaView === 'json' ? 'on' : ''}
                onClick={() => setSchemaView('json')}
              >
                JSON
              </button>
            </div>
          )}
        </div>
        {node.jsonSchema == null ? (
          <div className="empty">No JSON Schema emitted for this schema.</div>
        ) : schemaView === 'fields' ? (
          <EntityCard schema={node.jsonSchema as JSchema} name={node.name} />
        ) : (
          <pre className="json">{JSON.stringify(node.jsonSchema, null, 2)}</pre>
        )}
      </section>
    </>
  );
}
