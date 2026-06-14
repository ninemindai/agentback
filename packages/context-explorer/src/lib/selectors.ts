// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingNode} from '../model.js';

export interface Facets {
  kind: Map<string, number>;
  scope: Map<string, number>;
  type: Map<string, number>;
  tag: Map<string, number>;
  extensionPoint: Map<string, number>;
  lifeCycleGroup: Map<string, number>;
  context: Map<string, number>;
}

const bump = (m: Map<string, number>, k: string | undefined) => {
  if (k == null) return;
  m.set(k, (m.get(k) ?? 0) + 1);
};

export function facets(bindings: BindingNode[]): Facets {
  const f: Facets = {
    kind: new Map(),
    scope: new Map(),
    type: new Map(),
    tag: new Map(),
    extensionPoint: new Map(),
    lifeCycleGroup: new Map(),
    context: new Map(),
  };
  for (const b of bindings) {
    for (const k of b.kinds) bump(f.kind, k);
    bump(f.scope, b.scope);
    bump(f.type, b.type);
    bump(f.context, b.context);
    bump(f.extensionPoint, b.extensionPoint);
    bump(f.lifeCycleGroup, b.lifeCycleGroup);
    for (const t of b.tags) bump(f.tag, t.name);
  }
  return f;
}

/** point name -> extensions contributing to it (from extensionFor values). */
export function extensionGroups(
  bindings: BindingNode[],
): Map<string, BindingNode[]> {
  const g = new Map<string, BindingNode[]>();
  for (const b of bindings) {
    for (const pt of b.extensionFor ?? []) {
      (g.get(pt) ?? g.set(pt, []).get(pt)!).push(b);
    }
  }
  return g;
}

/** Prefix for synthetic extension-point node ids (points with no binding). */
export const EXTENSION_POINT_PREFIX = 'extension-point:';

/** Extension-point wiring for the graph: edges plus any synthetic point nodes. */
export interface ExtensionGraph {
  /**
   * Synthetic nodes for extension points referenced by `extensionFor` that have
   * NO declared `@extensionPoint` binding (e.g. `mcpServers`, consumed by the
   * MCP server via a tag filter). `id` is prefixed; `name` is the bare point.
   */
  points: {id: string; name: string}[];
  /** `from` (extension binding key) -> `to` (point node id): "extends". */
  edges: {from: string; to: string}[];
}

/**
 * Build extension-point wiring. Each binding's `extensionFor` names the point(s)
 * it registers with. A point with a declared `@extensionPoint` binding anchors
 * the edge on that binding's key; a point with no binding gets a synthetic node
 * (`EXTENSION_POINT_PREFIX + name`) so the wiring is still visible. Self-edges
 * are dropped.
 */
export function extensionGraph(bindings: BindingNode[]): ExtensionGraph {
  const pointKeyByName = new Map<string, string>();
  for (const b of bindings) {
    if (b.extensionPoint) pointKeyByName.set(b.extensionPoint, b.key);
  }
  const synthetic = new Map<string, string>(); // name -> synthetic node id
  const edges: {from: string; to: string}[] = [];
  for (const b of bindings) {
    for (const name of b.extensionFor ?? []) {
      let pointId = pointKeyByName.get(name);
      if (!pointId) {
        pointId = EXTENSION_POINT_PREFIX + name;
        synthetic.set(name, pointId);
      }
      if (pointId !== b.key) edges.push({from: b.key, to: pointId});
    }
  }
  return {
    points: [...synthetic].map(([name, id]) => ({id, name})),
    edges,
  };
}

/**
 * Reference edges for the graph that follow a binding to another binding it
 * names: a config binding -> the binding it configures (`configurationFor`), and
 * an alias binding -> its target (`source`, for `Alias`-typed bindings). Targets
 * that aren't bound (dangling) and self-edges are dropped.
 */
export function referenceEdges(
  bindings: BindingNode[],
): {from: string; to: string; kind: 'config' | 'alias'}[] {
  const keys = new Set(bindings.map(b => b.key));
  const edges: {from: string; to: string; kind: 'config' | 'alias'}[] = [];
  for (const b of bindings) {
    const cfg = b.configurationFor;
    if (cfg && cfg !== b.key && keys.has(cfg)) {
      edges.push({from: b.key, to: cfg, kind: 'config'});
    }
    if (b.type === 'Alias' && b.source && b.source !== b.key) {
      if (keys.has(b.source)) {
        edges.push({from: b.key, to: b.source, kind: 'alias'});
      }
    }
  }
  return edges;
}

/** target key -> config binding keys that configure it. */
export function configEdges(bindings: BindingNode[]): Map<string, string[]> {
  const e = new Map<string, string[]>();
  for (const b of bindings) {
    if (b.configurationFor == null) continue;
    const t = b.configurationFor;
    (e.get(t) ?? e.set(t, []).get(t)!).push(b.key);
  }
  return e;
}

/** source class name -> bindings sharing it (dual-binding join, finding A). */
export function dualByCtor(
  bindings: BindingNode[],
): Map<string, BindingNode[]> {
  const m = new Map<string, BindingNode[]>();
  for (const b of bindings) {
    if (!b.source) continue;
    (m.get(b.source) ?? m.set(b.source, []).get(b.source)!).push(b);
  }
  return m;
}
