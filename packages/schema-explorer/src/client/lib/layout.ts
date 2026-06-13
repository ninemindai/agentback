// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import dagre from '@dagrejs/dagre';
import {MarkerType, Position, type Edge, type Node} from '@xyflow/react';
import type {SchemaGraph} from '../api';

export const NODE_W = 220;
export const NODE_H = 42;

// Warm paper-palette tints, matching the rest of the console.
const SCHEMA_BOUND = '#e6ece2';
const SCHEMA_UNBOUND = '#ece6d8';
const REST_FILL = '#e1eae6';
const MCP_FILL = '#f0e0db';

/**
 * Lay out the provenance graph left-to-right with dagre: schema entities on the
 * left, the routes/tools that use them on the right. A `schema -> surface` edge
 * is fed to dagre as-is so schemas rank left of their consumers. Edge labels
 * carry the role (body/response/input/…). Surface nodes are tinted by protocol;
 * schema nodes are tinted solid (registered) or dashed (discovered).
 */
export function layoutSchemaGraph(graph: SchemaGraph): {
  nodes: Node[];
  edges: Edge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'LR',
    nodesep: 16,
    ranksep: 130,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes) g.setNode(n.id, {width: NODE_W, height: NODE_H});
  for (const s of graph.surfaces)
    g.setNode(s.id, {width: NODE_W, height: NODE_H});
  for (const e of graph.edges) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  }

  dagre.layout(g);

  const place = (id: string) => {
    const p = g.node(id);
    return {x: p.x - NODE_W / 2, y: p.y - NODE_H / 2};
  };

  const schemaNodes: Node[] = graph.nodes.map(n => ({
    id: n.id,
    position: place(n.id),
    data: {label: n.name},
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    width: NODE_W,
    height: NODE_H,
    style: {
      background: n.bound ? SCHEMA_BOUND : SCHEMA_UNBOUND,
      border: `1px ${n.bound ? 'solid' : 'dashed'} var(--line-2)`,
      borderRadius: 6,
      fontFamily: 'ui-monospace,monospace',
      fontSize: 11,
    },
  }));

  const surfaceNodes: Node[] = graph.surfaces.map(s => ({
    id: s.id,
    position: place(s.id),
    data: {label: s.ref},
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    width: NODE_W,
    height: NODE_H,
    style: {
      background: s.surface === 'rest' ? REST_FILL : MCP_FILL,
      border: '1px solid var(--line-2)',
      borderRadius: 6,
      fontFamily: 'ui-monospace,monospace',
      fontSize: 11,
    },
  }));

  const edges: Edge[] = graph.edges.map(e => ({
    id: `${e.from}->${e.to}:${e.role}`,
    source: e.from,
    target: e.to,
    label: e.role,
    labelStyle: {fontSize: 9, fill: 'var(--muted)'},
    labelBgStyle: {fill: 'var(--paper)'},
    markerEnd: {type: MarkerType.ArrowClosed, width: 14, height: 14},
  }));

  return {nodes: [...schemaNodes, ...surfaceNodes], edges};
}
