// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import dagre from '@dagrejs/dagre';
import {MarkerType, Position, type Edge, type Node} from '@xyflow/react';

export const NODE_W = 230;
export const NODE_H = 44;

/** Kind of a graph edge: an injection dependency or extension-point wiring. */
export type EdgeKind = 'dep' | 'extension';

/** Whether a graph node is a real binding or a synthetic extension point. */
export type NodeKind = 'binding' | 'extensionPoint';

/** Minimal graph shape consumed by the layout (derived from the model). */
export interface LayoutGraph {
  nodes: {
    key: string;
    scope: string;
    type?: string;
    /** Defaults to `binding`; `extensionPoint` for synthetic point nodes. */
    nodeKind?: NodeKind;
    /** Display label (defaults to `key`); synthetic points show the bare name. */
    label?: string;
  }[];
  /**
   * `from` depends on `to`. For `dep` edges `from` injects the binding `to`;
   * for `extension` edges `from` is the extension point and `to` an extension
   * it aggregates. Both rank `to` to the left of `from`.
   */
  edges: {from: string; to: string; kind?: EdgeKind}[];
}

/**
 * Lay out the dependency graph left-to-right with dagre and produce React Flow
 * nodes/edges. Dependencies are ranked to the LEFT of their dependents: a
 * `from -> to` edge ("from depends on to") is fed to dagre as `to -> from`, so
 * `to` (the dependency) gets the lower rank. The rendered React Flow edge keeps
 * the semantic direction (arrow points from dependent to dependency).
 */
export function layoutGraph(graph: LayoutGraph): {
  nodes: Node[];
  edges: Edge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'LR',
    nodesep: 24,
    ranksep: 90,
    marginx: 20,
    marginy: 20,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of graph.nodes)
    g.setNode(n.key, {width: NODE_W, height: NODE_H});
  for (const e of graph.edges) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.to, e.from);
  }

  dagre.layout(g);

  const nodes: Node[] = graph.nodes.map(n => {
    const pos = g.node(n.key);
    return {
      id: n.key,
      // dagre gives center coords; React Flow wants top-left.
      position: {x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2},
      data: {
        label: n.label ?? n.key,
        scope: n.scope,
        type: n.type ?? '',
        nodeKind: n.nodeKind ?? 'binding',
      },
      // The semantic edge runs dependent -> dependency, i.e. right -> left,
      // so the edge leaves a node on its left and arrives on its right.
      sourcePosition: Position.Left,
      targetPosition: Position.Right,
      width: NODE_W,
      height: NODE_H,
    };
  });

  const edges: Edge[] = graph.edges.map(e => {
    const kind: EdgeKind = e.kind ?? 'dep';
    return {
      id: e.from + '->' + e.to + ':' + kind,
      source: e.from,
      target: e.to,
      data: {kind},
      markerEnd: {type: MarkerType.ArrowClosed, width: 16, height: 16},
    };
  });

  return {nodes, edges};
}
