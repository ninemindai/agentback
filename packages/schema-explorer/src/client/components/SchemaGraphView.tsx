// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {useEffect, useMemo, useState} from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type {SchemaGraph} from '../api';
import {useApi} from '../ApiContext';
import {layoutSchemaGraph} from '../lib/layout';

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Provenance graph view. Fetches `/graph` and renders schema entities (left)
 * wired to the routes/tools that use them (right) with React Flow. Clicking a
 * schema node selects it; surface nodes (ids like `rest::POST /x`) are not
 * selectable as entities, so clicks on them are ignored.
 */
export function SchemaGraphView({selectedId, onSelect}: Props) {
  const api = useApi();
  const [graph, setGraph] = useState<SchemaGraph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.fetchGraph().then(setGraph, e => setError(String(e)));
  }, [api]);

  const {nodes, edges} = useMemo(
    () => (graph ? layoutSchemaGraph(graph) : {nodes: [], edges: []}),
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

  if (error) return <div className="err">{error}</div>;

  return (
    <ReactFlow
      nodes={styledNodes}
      edges={edges}
      fitView
      proOptions={{hideAttribution: true}}
      onNodeClick={(_e, node: Node) => {
        // Only schema nodes are selectable; surface ids carry a `::`.
        if (!node.id.includes('::')) onSelect(node.id);
      }}
    >
      <Background />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
