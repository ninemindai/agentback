// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import type {SchemaNode} from '../api';

interface Props {
  nodes: SchemaNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Count usages per surface for the row summary badges. */
function counts(n: SchemaNode): {rest: number; mcp: number} {
  let rest = 0;
  let mcp = 0;
  for (const u of n.usages) {
    if (u.surface === 'rest') rest++;
    else if (u.surface === 'mcp') mcp++;
  }
  return {rest, mcp};
}

/**
 * The entity catalog: one row per schema node, with at-a-glance badges for
 * REST/MCP usage counts, Drizzle table origin, and a dashed "unused" flag for
 * registered schemas no boundary touches (a dead-schema / drift signal).
 */
export function SchemaList({nodes, selectedId, onSelect}: Props) {
  if (!nodes.length) {
    return <div className="empty">No schemas found.</div>;
  }
  return (
    <>
      {nodes.map(n => {
        const c = counts(n);
        return (
          <button
            key={n.id}
            className={'row' + (n.id === selectedId ? ' sel' : '')}
            onClick={() => onSelect(n.id)}
          >
            <div className={'name' + (n.bound ? '' : ' synth')}>{n.name}</div>
            <div className="meta">
              {c.rest > 0 && <span className="badge rest">REST ×{c.rest}</span>}
              {c.mcp > 0 && <span className="badge mcp">MCP ×{c.mcp}</span>}
              {n.origin?.table && (
                <span className="badge table">⛁ {n.origin.table}</span>
              )}
              {n.bound && n.usages.length === 0 && (
                <span className="badge unused">unused</span>
              )}
            </div>
          </button>
        );
      })}
    </>
  );
}
