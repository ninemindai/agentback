// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingNode, ContextNode} from '../model.js';

export interface ContextTreeNode {
  name: string;
  bindings: BindingNode[];
  children: ContextTreeNode[];
}

/** Build a forest of contexts (by `parent`), each carrying its own bindings. */
export function buildContextTree(
  contexts: ContextNode[],
  bindings: BindingNode[],
): ContextTreeNode[] {
  const byName = new Map<string, ContextTreeNode>();
  for (const c of contexts) {
    if (!byName.has(c.name)) {
      byName.set(c.name, {name: c.name, bindings: [], children: []});
    }
  }
  for (const b of bindings) {
    byName.get(b.context)?.bindings.push(b);
  }
  const roots: ContextTreeNode[] = [];
  for (const c of contexts) {
    const node = byName.get(c.name)!;
    if (c.parent && byName.has(c.parent)) {
      byName.get(c.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
