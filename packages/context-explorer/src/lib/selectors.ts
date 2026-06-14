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
