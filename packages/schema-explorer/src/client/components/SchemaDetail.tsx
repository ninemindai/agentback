// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import type {SchemaNode} from '../api';

interface Props {
  node: SchemaNode;
}

/**
 * Per-entity detail: where it's used (the provenance list, the cross-protocol
 * payoff), its origin, and the emitted JSON Schema fields. The "Used by" list
 * is the point — it reconciles the same schema across REST + MCP + DB in one
 * place, and flags registered schemas nothing uses.
 */
export function SchemaDetail({node}: Props) {
  const sub = [
    node.bindingKey,
    node.origin?.table ? `table: ${node.origin.table}` : null,
    node.origin?.kind ? `kind: ${node.origin.kind}` : null,
    node.bound ? 'registered' : 'discovered',
  ]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <>
      <h2>{node.name}</h2>
      <p className="sub">{sub}</p>

      <div className="uses">
        <h3>Used by</h3>
        {node.usages.length === 0 ? (
          <div className="empty">
            <span className="empty" />
            Not used by any route or tool — possibly a dead schema.
          </div>
        ) : (
          <ul>
            {node.usages.map((u, i) => (
              <li key={i}>
                <span className={'badge ' + u.surface}>
                  {u.surface.toUpperCase()}
                </span>
                <span className="ref">{u.ref}</span>
                <span className="role">{u.role}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="fields">
        <h3>Schema</h3>
        {node.jsonSchema ? (
          <pre className="json">{JSON.stringify(node.jsonSchema, null, 2)}</pre>
        ) : (
          <div className="empty">No JSON Schema emitted for this schema.</div>
        )}
      </div>
    </>
  );
}
