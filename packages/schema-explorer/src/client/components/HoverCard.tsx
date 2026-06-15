// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import type {SchemaNode} from '../api';
import {objectShape, typeLabel, type JSchema} from '../lib/jsonschema';

interface Props {
  node: SchemaNode;
  /** Cursor position relative to the graph container. */
  x: number;
  y: number;
}

const PEEK_FIELDS = 4;

function peekFields(schema: unknown): {name: string; type: string}[] {
  const shape = objectShape((schema ?? {}) as JSchema);
  if (!shape?.properties) return [];
  return Object.entries(shape.properties).map(([name, s]) => ({
    name,
    type: typeLabel(s),
  }));
}

/**
 * Lightweight popover shown while hovering a schema node in the graph: a quick
 * summary (provenance + field count + a few field rows) so the graph stays
 * scannable without opening the full drawer. Purely presentational and
 * non-interactive (`pointer-events:none`) so it never blocks the graph.
 */
export function HoverCard({node, x, y}: Props) {
  const fields = peekFields(node.jsonSchema);
  const shown = fields.slice(0, PEEK_FIELDS);
  const more = fields.length - shown.length;
  const plural = (n: number) => (n === 1 ? '' : 's');

  return (
    <div className="hovercard" style={{left: x, top: y}}>
      <div className="hc-eyebrow">
        {node.bound ? 'Registered' : 'Discovered'}
        {node.fieldCount != null &&
          ` · ${node.fieldCount} field${plural(node.fieldCount)}`}
      </div>
      <div className="hc-name">{node.name}</div>
      <div className="hc-meta">
        {node.origin?.table && (
          <span className="hc-tag">
            <span className="g">⛁</span>
            {node.origin.table}
          </span>
        )}
        <span className="hc-uses">
          {node.usages.length} usage{plural(node.usages.length)}
        </span>
      </div>
      {shown.length > 0 && (
        <ul className="hc-fields">
          {shown.map(f => (
            <li key={f.name}>
              <span className="fn">{f.name}</span>
              <span className="ft">{f.type}</span>
            </li>
          ))}
          {more > 0 && <li className="more">+{more} more</li>}
        </ul>
      )}
    </div>
  );
}
