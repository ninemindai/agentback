// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {buildContextTree, type ContextTreeNode} from '../../lib/hierarchy';
import type {BindingNode, ContextNode} from '../api';

interface Props {
  contexts: ContextNode[];
  bindings: BindingNode[];
  onSelect: (key: string) => void;
}

export function HierarchyView({contexts, bindings, onSelect}: Props) {
  const tree = buildContextTree(contexts, bindings);
  return (
    <div className="hierarchy">
      {tree.map(n => (
        <Ctx key={n.name} node={n} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Ctx({
  node,
  onSelect,
}: {
  node: ContextTreeNode;
  onSelect: (k: string) => void;
}) {
  return (
    <div className="ctxnode">
      <div className="ctxhead">
        <span className="ctxname">{node.name}</span>
        <span className="count">{node.bindings.length} bindings</span>
      </div>
      <ul className="ctxbindings">
        {node.bindings.map(b => (
          <li key={b.key}>
            <button className="dep" onClick={() => onSelect(b.key)}>
              {b.key}
            </button>
          </li>
        ))}
      </ul>
      {node.children.length > 0 && (
        <div className="ctxchildren">
          {node.children.map(c => (
            <Ctx key={c.name} node={c} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
