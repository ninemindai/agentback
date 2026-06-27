// Copyright NineMind, Inc. 2026. All Rights Reserved.
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
import {extensionGraph, referenceEdges, viewEdges} from '../../lib/selectors';
import type {EdgeKind} from '../lib/layout';

// Violet matches the extension edges + the `type-provider` token; used for the
// synthetic extension-point nodes that have no backing binding.
const EXT_POINT_FILL = '#efe7f3';
const EXT_POINT_BORDER = '#7a4fa3';

// Per-kind edge styling. Each kind gets a distinct hue + dash so the four
// relationship types stay legible; any edge incident to the selection turns
// accent-red while keeping its dash pattern.
const EDGE_STYLE: Record<EdgeKind, {color: string; dash?: string}> = {
  dep: {color: '#b6ab95'},
  view: {color: '#3f8f7a', dash: '2 3'},
  extension: {color: '#7a4fa3', dash: '5 4'},
  config: {color: '#3f6d8c', dash: '1 3'},
  alias: {color: '#b07a2e', dash: '6 3'},
};

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

// Node fill keyed on scope (matching the `.fdot.scope-*` tokens) so the graph
// is scannable by lifecycle scope: singleton green, transient amber, context
// blue, else a neutral paper tint.
const SCOPE_FILL: Record<string, string> = {
  Singleton: '#4f7d5b',
  Transient: '#9a6b2f',
  Context: '#3f6d8c',
};

function scopeFill(scope: string): string {
  return SCOPE_FILL[scope] ?? '#ece6d8';
}

// White text reads on the saturated scope fills; dark text on the neutral
// default keeps the paper look for unscoped/finer-grained scopes.
function scopeText(scope: string): string {
  return scope in SCOPE_FILL ? '#f6f1e6' : '#221d16';
}

function nodeLabel(
  label: string,
  scope: string,
  type: string,
  isPoint: boolean,
) {
  return (
    <div style={{lineHeight: 1.15, textAlign: 'left'}}>
      <div
        style={{
          fontFamily: 'ui-monospace,monospace',
          fontSize: 11,
          wordBreak: 'break-all',
        }}
      >
        {label}
      </div>
      <div style={{fontSize: 9, opacity: 0.7, marginTop: 2}}>
        {isPoint ? 'extension point' : scope + (type ? ' · ' + type : '')}
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

  // Build the layout graph from the model: nodes are bindings; edges are
  // injection dependencies (`dependsOn`) PLUS extension-point wiring. The model
  // can repeat the same binding key across contexts in the parent chain, so
  // dedup nodes by key (keep the first occurrence) to avoid duplicate ids.
  const graph = useMemo<LayoutGraph>(() => {
    const byKey = new Map<string, LayoutGraph['nodes'][number]>();
    for (const b of bindings) {
      if (!byKey.has(b.key)) {
        byKey.set(b.key, {key: b.key, scope: b.scope, type: b.type});
      }
    }
    const edges: LayoutGraph['edges'] = bindings.flatMap(b =>
      b.dependsOn.map(to => ({from: b.key, to, kind: 'dep' as const})),
    );
    // Extension wiring is tag-based (absent from `dependsOn`): connect each
    // extension point to the extensions registered for it. Points with no
    // declared binding (e.g. `mcpServers`) get a synthetic node so the edge
    // still has somewhere to land.
    const ext = extensionGraph(bindings);
    for (const p of ext.points) {
      if (!byKey.has(p.id)) {
        byKey.set(p.id, {
          key: p.id,
          scope: '',
          nodeKind: 'extensionPoint',
          label: p.name,
        });
      }
    }
    for (const e of ext.edges) edges.push({...e, kind: 'extension'});
    // Config-binding -> configured binding, and alias -> alias target.
    for (const e of referenceEdges(bindings)) edges.push(e);
    // Tag-view injections: injector -> every binding carrying the tag.
    for (const e of viewEdges(bindings)) edges.push(e);
    return {nodes: [...byKey.values()], edges};
  }, [bindings]);

  const base = useMemo(() => layoutGraph(graph), [graph]);

  // Lookups for the hover tooltip: full binding metadata + dependency counts.
  const byKey = useMemo(() => {
    const m = new Map<string, BindingNode>();
    for (const b of bindings) m.set(b.key, b);
    return m;
  }, [bindings]);

  // Synthetic extension-point node id -> display name, for the hover tooltip.
  const pointNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of base.nodes) {
      const d = n.data as {label: string; nodeKind?: string};
      if (d.nodeKind === 'extensionPoint') m.set(n.id, d.label);
    }
    return m;
  }, [base.nodes]);

  // Dependency counts for the tooltip exclude extension edges (those are not
  // "deps"), so the "X out · Y in" figures stay true to injection wiring.
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    const inc = new Map<string, number>();
    for (const e of base.edges) {
      // Only injection dependencies count toward the "deps" figures.
      if ((e.data as {kind?: string} | undefined)?.kind !== 'dep') continue;
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
        const data = n.data as {
          label: string;
          scope: string;
          type: string;
          nodeKind?: string;
        };
        const isPoint = data.nodeKind === 'extensionPoint';
        const isSel = n.id === selectedKey;
        const dimmed = selectedKey != null && !isSel && !incident.has(n.id);
        return {
          ...n,
          data: {
            ...n.data,
            label: nodeLabel(data.label, data.scope, data.type, isPoint),
          },
          style: {
            width: n.width,
            padding: 6,
            borderRadius: 5,
            border: isSel
              ? '1.5px solid #9a3324'
              : isPoint
                ? '1.5px dashed ' + EXT_POINT_BORDER
                : '1px solid #cabfa6',
            background: isPoint ? EXT_POINT_FILL : scopeFill(data.scope),
            color: isPoint ? EXT_POINT_BORDER : scopeText(data.scope),
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
        const kind = (e.data as {kind?: EdgeKind} | undefined)?.kind ?? 'dep';
        const sty = EDGE_STYLE[kind];
        // Each kind keeps its hue + dash; incident edges turn accent-red.
        const color = on ? '#9a3324' : sty.color;
        const markerEnd =
          typeof e.markerEnd === 'string' || e.markerEnd == null
            ? e.markerEnd
            : {...e.markerEnd, color};
        return {
          ...e,
          animated: on,
          style: {
            stroke: color,
            strokeWidth: on ? 2 : 1.2,
            strokeDasharray: sty.dash,
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
      <GraphLegend />
      {hover && (
        <NodeTooltip
          binding={byKey.get(hover.key)}
          fallbackKey={pointNameById.get(hover.key) ?? hover.key}
          isPoint={pointNameById.has(hover.key)}
          dependsOn={counts.out.get(hover.key) ?? 0}
          dependedOnBy={counts.inc.get(hover.key) ?? 0}
          x={hover.x}
          y={hover.y}
        />
      )}
    </>
  );
}

const LEGEND: {kind: EdgeKind; label: string}[] = [
  {kind: 'dep', label: 'depends on'},
  {kind: 'view', label: 'injects by tag'},
  {kind: 'extension', label: 'extension → extension point'},
  {kind: 'config', label: 'configures'},
  {kind: 'alias', label: 'alias → target'},
];

/** Bottom-left key explaining the edge kinds. */
function GraphLegend() {
  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        zIndex: 5,
        display: 'grid',
        gap: 4,
        padding: '.5rem .6rem',
        background: 'var(--card)',
        border: '1px solid var(--line-2)',
        borderRadius: 6,
        font: '11px var(--mono)',
        color: 'var(--muted)',
        pointerEvents: 'none',
      }}
    >
      {LEGEND.map(({kind, label}) => (
        <span key={kind}>
          <svg width="22" height="8" style={{verticalAlign: 'middle'}}>
            <line
              x1="0"
              y1="4"
              x2="22"
              y2="4"
              stroke={EDGE_STYLE[kind].color}
              strokeWidth="1.6"
              strokeDasharray={EDGE_STYLE[kind].dash}
            />
          </svg>{' '}
          {label}
        </span>
      ))}
    </div>
  );
}

function NodeTooltip({
  binding,
  fallbackKey,
  isPoint,
  dependsOn,
  dependedOnBy,
  x,
  y,
}: {
  binding: BindingNode | undefined;
  fallbackKey: string;
  isPoint: boolean;
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
        {isPoint ? (
          <>
            <dt>Kind</dt>
            <dd>extension point</dd>
          </>
        ) : (
          <>
            <dt>Deps</dt>
            <dd>
              {dependsOn} out · {dependedOnBy} in
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}
