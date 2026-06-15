// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {useEffect, useMemo, useRef, useState} from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {SchemaGraph, SchemaNode} from '../api';
import {useApi} from '../ApiContext';
import {layoutSchemaGraph} from '../lib/layout';
import {HoverCard} from './HoverCard';
import {SchemaDetail} from './SchemaDetail';

interface Props {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

interface Hover {
  node: SchemaNode;
  x: number;
  y: number;
}

/**
 * Provenance graph view. Fetches `/graph` and renders schema entities (left)
 * wired to the routes/tools that use them (right) with React Flow. Hovering a
 * schema node shows a quick {@link HoverCard} peek; clicking one selects it and
 * opens a drawer with the full {@link SchemaDetail} card. Surface nodes have no
 * card, so hovers/clicks on them are ignored. The graph `/graph` payload already
 * carries full `SchemaNode`s, so the card data needs no extra fetch.
 */
export function SchemaGraphView({selectedId, onSelect}: Props) {
  const api = useApi();
  const [graph, setGraph] = useState<SchemaGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.fetchGraph().then(setGraph, e => setError(String(e)));
  }, [api]);

  const {nodes, edges} = useMemo(
    () => (graph ? layoutSchemaGraph(graph) : {nodes: [], edges: []}),
    [graph],
  );

  // Full entity records keyed by id, for the hover peek + drawer cards.
  const byId = useMemo(
    () => new Map((graph?.nodes ?? []).map(n => [n.id, n])),
    [graph],
  );

  // Highlight the selected schema node.
  const styledNodes = useMemo(
    () =>
      nodes.map(n =>
        n.id === selectedId
          ? {...n, style: {...n.style, boxShadow: '0 0 0 2px var(--accent)'}}
          : n,
      ),
    [nodes, selectedId],
  );

  const selectedNode = selectedId ? (byId.get(selectedId) ?? null) : null;

  // Cursor position relative to the graph wrapper, for placing the hover card.
  const relative = (clientX: number, clientY: number) => {
    const r = wrapRef.current?.getBoundingClientRect();
    return {x: clientX - (r?.left ?? 0) + 14, y: clientY - (r?.top ?? 0) + 14};
  };

  // Only schema entities (ids in `byId`) have a card; surface nodes (routes /
  // tools, kept in `graph.surfaces`) are not selectable and have no peek.
  const onNodeHover = (e: React.MouseEvent, node: Node) => {
    const entity = byId.get(node.id);
    if (!entity) return setHover(null);
    setHover({node: entity, ...relative(e.clientX, e.clientY)});
  };

  if (error) return <div className="err">{error}</div>;

  return (
    <div className="graphwrap" ref={wrapRef}>
      <ReactFlow
        nodes={styledNodes}
        edges={edges}
        fitView
        proOptions={{hideAttribution: true}}
        onNodeClick={(_e, node: Node) => {
          if (byId.has(node.id)) onSelect(node.id);
        }}
        onNodeMouseEnter={onNodeHover}
        onNodeMouseMove={onNodeHover}
        onNodeMouseLeave={() => setHover(null)}
        onPaneClick={() => onSelect(null)}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>

      {hover && <HoverCard node={hover.node} x={hover.x} y={hover.y} />}

      {selectedNode && (
        <aside className="drawer">
          <button
            className="drawer-close"
            onClick={() => onSelect(null)}
            aria-label="Close"
          >
            ×
          </button>
          <div className="detail">
            <SchemaDetail node={selectedNode} />
          </div>
        </aside>
      )}
    </div>
  );
}
