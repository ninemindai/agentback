// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {useMemo, useState} from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {type BindingNode} from '../api';
import {layoutGraph, type LayoutGraph} from '../lib/layout';

interface Props {
  selectedKey: string | null;
  onSelect: (key: string) => void;
  bindings: BindingNode[];
}

interface Hover {
  key: string;
  x: number;
  y: number;
}

// Warm paper-palette tint per binding type so kinds are scannable at a glance.
const TYPE_FILL: Record<string, string> = {
  Class: '#e6ece2',
  Provider: '#efe5d6',
  Constant: '#ece6d8',
  Alias: '#e1eae6',
  Function: '#f0e6db',
};

function nodeLabel(key: string, scope: string, type: string) {
  return (
    <div style={{lineHeight: 1.15, textAlign: 'left'}}>
      <div
        style={{
          fontFamily: 'ui-monospace,monospace',
          fontSize: 11,
          wordBreak: 'break-all',
        }}
      >
        {key}
      </div>
      <div style={{fontSize: 9, opacity: 0.7, marginTop: 2}}>
        {scope}
        {type ? ' · ' + type : ''}
      </div>
    </div>
  );
}

/**
 * Dependency graph view. Derives its nodes/edges from the model's binding
 * `dependsOn` lists, lays it out left-to-right (deps on the left), and renders
 * it with React Flow (pan/zoom/drag, minimap, controls). Selecting a node
 * highlights it and its incident dependency edges.
 */
export function GraphView({selectedKey, onSelect, bindings}: Props) {
  const [hover, setHover] = useState<Hover | null>(null);

  // Build the layout graph from the model: nodes are bindings, edges come from
  // each binding's `dependsOn` ("from depends on to").
  const graph = useMemo<LayoutGraph>(
    () => ({
      nodes: bindings.map(b => ({key: b.key, scope: b.scope, type: b.type})),
      edges: bindings.flatMap(b => b.dependsOn.map(to => ({from: b.key, to}))),
    }),
    [bindings],
  );

  const base = useMemo(() => layoutGraph(graph), [graph]);

  // Lookups for the hover tooltip: full binding metadata + dependency counts.
  const byKey = useMemo(() => {
    const m = new Map<string, BindingNode>();
    for (const b of bindings) m.set(b.key, b);
    return m;
  }, [bindings]);

  const counts = useMemo(() => {
    const out = new Map<string, number>();
    const inc = new Map<string, number>();
    for (const e of base.edges) {
      out.set(e.source, (out.get(e.source) ?? 0) + 1);
      inc.set(e.target, (inc.get(e.target) ?? 0) + 1);
    }
    return {out, inc};
  }, [base.edges]);

  // Nodes/edges connected to the selected binding, for highlighting.
  const incident = useMemo(() => {
    const s = new Set<string>();
    if (selectedKey) {
      for (const e of base.edges) {
        if (e.source === selectedKey || e.target === selectedKey) {
          s.add(e.source);
          s.add(e.target);
        }
      }
    }
    return s;
  }, [base.edges, selectedKey]);

  const nodes: Node[] = useMemo(
    () =>
      base.nodes.map(n => {
        const data = n.data as {label: string; scope: string; type: string};
        const isSel = n.id === selectedKey;
        const dimmed = selectedKey != null && !isSel && !incident.has(n.id);
        return {
          ...n,
          data: {
            ...n.data,
            label: nodeLabel(data.label, data.scope, data.type),
          },
          style: {
            width: n.width,
            padding: 6,
            borderRadius: 5,
            border: isSel ? '1.5px solid #9a3324' : '1px solid #cabfa6',
            background: TYPE_FILL[data.type] ?? '#ece6d8',
            color: '#221d16',
            fontFamily: "'JetBrains Mono',ui-monospace,monospace",
            opacity: dimmed ? 0.28 : 1,
            boxShadow: isSel
              ? '0 0 0 3px rgba(154,51,36,.16)'
              : '0 1px 0 rgba(34,29,22,.04)',
          },
        };
      }),
    [base.nodes, incident, selectedKey],
  );

  const edges: Edge[] = useMemo(
    () =>
      base.edges.map(e => {
        const on =
          selectedKey != null &&
          (e.source === selectedKey || e.target === selectedKey);
        const markerEnd =
          typeof e.markerEnd === 'string' || e.markerEnd == null
            ? e.markerEnd
            : {
                ...e.markerEnd,
                color: on ? '#9a3324' : '#b6ab95',
              };
        return {
          ...e,
          animated: on,
          style: {
            stroke: on ? '#9a3324' : '#b6ab95',
            strokeWidth: on ? 2 : 1.2,
          },
          markerEnd,
        };
      }),
    [base.edges, selectedKey],
  );

  if (graph.nodes.length === 0) {
    return <p className="empty">No bindings to graph.</p>;
  }

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, node) => onSelect(node.id)}
        onNodeMouseEnter={(e, node) =>
          setHover({key: node.id, x: e.clientX, y: e.clientY})
        }
        onNodeMouseMove={(e, node) =>
          setHover({key: node.id, x: e.clientX, y: e.clientY})
        }
        onNodeMouseLeave={() => setHover(null)}
        fitView
        minZoom={0.2}
        proOptions={{hideAttribution: true}}
        nodesConnectable={false}
        nodesDraggable
      >
        <Background gap={20} color="#d3c8b2" />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
      {hover && (
        <NodeTooltip
          binding={byKey.get(hover.key)}
          fallbackKey={hover.key}
          dependsOn={counts.out.get(hover.key) ?? 0}
          dependedOnBy={counts.inc.get(hover.key) ?? 0}
          x={hover.x}
          y={hover.y}
        />
      )}
    </>
  );
}

function NodeTooltip({
  binding,
  fallbackKey,
  dependsOn,
  dependedOnBy,
  x,
  y,
}: {
  binding: BindingNode | undefined;
  fallbackKey: string;
  dependsOn: number;
  dependedOnBy: number;
  x: number;
  y: number;
}) {
  // Offset from the pointer; flip to the left near the right edge.
  const flip = x > window.innerWidth - 280;
  return (
    <div
      className="gtooltip"
      style={{
        left: flip ? undefined : x + 14,
        right: flip ? window.innerWidth - x + 14 : undefined,
        top: y + 14,
      }}
    >
      <div className="k">{binding?.key ?? fallbackKey}</div>
      <dl>
        {binding && (
          <>
            <dt>Scope</dt>
            <dd>{binding.scope}</dd>
            {binding.type && (
              <>
                <dt>Type</dt>
                <dd>{binding.type}</dd>
              </>
            )}
            {binding.source && (
              <>
                <dt>Source</dt>
                <dd>{binding.source}</dd>
              </>
            )}
            {binding.tags.length > 0 && (
              <>
                <dt>Tags</dt>
                <dd>
                  {binding.tags
                    .map(t =>
                      t.value === true ? t.name : `${t.name}=${t.value}`,
                    )
                    .join(', ')}
                </dd>
              </>
            )}
          </>
        )}
        <dt>Deps</dt>
        <dd>
          {dependsOn} out · {dependedOnBy} in
        </dd>
      </dl>
    </div>
  );
}
