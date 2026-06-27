// Copyright NineMind, Inc. 2026. All Rights Reserved.
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
  // Remember each context's first-seen parent (deduped by name) so the placement
  // loop can run off the deduped set rather than the raw `contexts` array.
  const parentByName = new Map<string, string | undefined>();
  for (const c of contexts) {
    if (!byName.has(c.name)) {
      byName.set(c.name, {name: c.name, bindings: [], children: []});
      parentByName.set(c.name, c.parent);
    }
  }
  for (const b of bindings) {
    // Orphan bindings (context with no matching node) are silently ignored.
    byName.get(b.context)?.bindings.push(b);
  }
  const roots: ContextTreeNode[] = [];
  // Iterate the deduped contexts so each name is placed exactly once, even if
  // `contexts` contained the same name twice (preserving first-seen order).
  for (const [name, node] of byName) {
    const parent = parentByName.get(name);
    // Root when there's no parent, the parent is unknown, or it's a self-parent;
    // otherwise attach as a child of its (existing, non-self) parent. The `!` is
    // safe because `parent` was just confirmed present in `byName`.
    if (parent && parent !== name && byName.has(parent)) {
      byName.get(parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
