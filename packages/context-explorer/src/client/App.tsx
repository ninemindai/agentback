// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {useEffect, useMemo, useState} from 'react';
import {makeApi, type BindingNode, type ContextModel} from './api';
import {ApiProvider} from './ApiContext';
import {BindingList} from './components/BindingList';
import {BindingDetail} from './components/BindingDetail';
import {GraphView} from './components/GraphView';
import {RawTree} from './components/RawTree';

type View = 'browse' | 'graph' | 'raw';

/**
 * Root component. Owns all UI state (model, selection, filters, view);
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
  const [model, setModel] = useState<ContextModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<View>('browse');

  useEffect(() => {
    api.fetchModel().then(setModel, e => setError(String(e)));
  }, [api]);

  const bindings: BindingNode[] = model?.bindings ?? [];

  // Adjacency maps derived from each node's `dependsOn`. An entry "from -> to"
  // means "from depends on to" (from injects the binding to).
  const {dependsOn, dependedOnBy} = useMemo(() => {
    const out = new Map<string, string[]>();
    const inc = new Map<string, string[]>();
    for (const b of bindings) {
      out.set(b.key, [...b.dependsOn]);
      for (const to of b.dependsOn) {
        (inc.get(to) ?? inc.set(to, []).get(to)!).push(b.key);
      }
    }
    return {dependsOn: out, dependedOnBy: inc};
  }, [bindings]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return bindings.filter(
      b =>
        (!q || b.key.toLowerCase().includes(q)) &&
        (!tag || b.tags.some(t => t.name === tag)),
    );
  }, [bindings, filter, tag]);

  const selected = useMemo(
    () => bindings.find(b => b.key === selectedKey) ?? null,
    [bindings, selectedKey],
  );

  if (error) return <p className="err">Failed to load model: {error}</p>;

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
