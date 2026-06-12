// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {useEffect, useMemo, useState} from 'react';
import {makeApi, type BindingSummary, type GraphEdge} from './api';
import {ApiProvider} from './ApiContext';
import {BindingList} from './components/BindingList';
import {BindingDetail} from './components/BindingDetail';
import {GraphView} from './components/GraphView';
import {RawTree} from './components/RawTree';

type View = 'browse' | 'graph' | 'raw';

/**
 * Root component. Owns all UI state (bindings, selection, filters, view);
 * the panes are pure functions of this state. No router, no global store.
 * `apiBase` is supplied by the standalone shell or the console, so the panel
 * is reusable under any mount path.
 */
export function App({
  apiBase,
  title = 'Context Explorer',
}: {
  apiBase: string;
  title?: string;
}) {
  const api = useMemo(() => makeApi(apiBase), [apiBase]);
  const [bindings, setBindings] = useState<BindingSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [view, setView] = useState<View>('browse');

  useEffect(() => {
    api.fetchBindings().then(setBindings, e => setError(String(e)));
    // Edges power the detail pane's dependency lists; failure is non-fatal.
    api.fetchGraph().then(
      g => setEdges(g.edges),
      () => {},
    );
  }, [api]);

  // Adjacency maps from the dependency edges. An edge {from, to} means
  // "from depends on to".
  const {dependsOn, dependedOnBy} = useMemo(() => {
    const out = new Map<string, string[]>();
    const inc = new Map<string, string[]>();
    for (const e of edges) {
      (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
      (inc.get(e.to) ?? inc.set(e.to, []).get(e.to)!).push(e.from);
    }
    return {dependsOn: out, dependedOnBy: inc};
  }, [edges]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return bindings.filter(
      b =>
        (!q || b.key.toLowerCase().includes(q)) &&
        (!tag || b.tags.includes(tag)),
    );
  }, [bindings, filter, tag]);

  const selected = useMemo(
    () => bindings.find(b => b.key === selectedKey) ?? null,
    [bindings, selectedKey],
  );

  if (error) return <p className="err">Failed to load bindings: {error}</p>;

  const views: View[] = ['browse', 'graph', 'raw'];
  const labels: Record<View, string> = {
    browse: 'Browse',
    graph: 'Graph',
    raw: 'Raw tree',
  };

  return (
    <ApiProvider value={api}>
      <header>
        <h1>{title}</h1>
        <span className="count">
          {visible.length} / {bindings.length} bindings
        </span>
        <div className="views">
          {views.map(v => (
            <button
              key={v}
              className={v === view ? 'btn' : 'ghost'}
              onClick={() => setView(v)}
            >
              {labels[v]}
            </button>
          ))}
        </div>
      </header>

      {view === 'raw' && (
        <div style={{padding: '1.25rem 1.5rem', overflow: 'auto'}}>
          <RawTree />
        </div>
      )}

      {view === 'graph' && (
        <div className="graphpane">
          <GraphView
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            bindings={bindings}
          />
        </div>
      )}

      {view === 'browse' && (
        <div className="layout">
          <div className="list">
            <input
              className="filter"
              placeholder="Filter by key…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {tag && (
              <div className="tagfilter">
                tag: <span className="badge">{tag}</span>
                <button className="ghost" onClick={() => setTag(null)}>
                  clear
                </button>
              </div>
            )}
            <BindingList
              bindings={visible}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              onTag={setTag}
            />
          </div>
          <div className="detail">
            <BindingDetail
              binding={selected}
              dependsOn={selected ? (dependsOn.get(selected.key) ?? []) : []}
              dependedOnBy={
                selected ? (dependedOnBy.get(selected.key) ?? []) : []
              }
              onSelect={setSelectedKey}
            />
          </div>
        </div>
      )}
    </ApiProvider>
  );
}
