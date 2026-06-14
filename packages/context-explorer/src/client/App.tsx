// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {useEffect, useMemo, useState} from 'react';
import {makeApi, type BindingNode, type ContextModel} from './api';
import {
  facets,
  configEdges,
  extensionGroups,
  dualByCtor,
} from '../lib/selectors';
import {ApiProvider} from './ApiContext';
import {FacetNav, type FacetChoice} from './components/FacetNav';
import {ResultsList} from './components/ResultsList';
import {BindingDetail} from './components/BindingDetail';
import {GraphView} from './components/GraphView';
import {HierarchyView} from './components/HierarchyView';
import {RawTree} from './components/RawTree';

type View = 'browse' | 'graph' | 'hierarchy' | 'raw';

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
  // Single-select: one active facet filter across the whole panel (or none).
  const [choice, setChoice] = useState<FacetChoice>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<View>('browse');

  // Pick a facet value; picking the active one again clears the filter.
  const pick = (facet: NonNullable<FacetChoice>['facet'], value: string) =>
    setChoice(prev =>
      prev && prev.facet === facet && prev.value === value
        ? null
        : {facet, value},
    );

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

  const allFacets = useMemo(() => facets(bindings), [bindings]);
  const cfgEdges = useMemo(() => configEdges(bindings), [bindings]);
  const extGroups = useMemo(() => extensionGroups(bindings), [bindings]);
  const duals = useMemo(() => dualByCtor(bindings), [bindings]);

  // The single active facet filter, applied alongside the free-text key filter.
  const matchChoice = (b: BindingNode): boolean => {
    if (!choice) return true;
    switch (choice.facet) {
      case 'kind':
        return b.kinds.includes(choice.value);
      case 'scope':
        return b.scope === choice.value;
      case 'type':
        return b.type === choice.value;
      case 'extensionPoint':
        return b.extensionPoint === choice.value;
      case 'lifeCycleGroup':
        return b.lifeCycleGroup === choice.value;
      case 'context':
        return b.context === choice.value;
      case 'tag':
        return b.tags.some(t => t.name === choice.value);
      default:
        return true;
    }
  };

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return bindings.filter(
      b => (!q || b.key.toLowerCase().includes(q)) && matchChoice(b),
    );
    // matchChoice closes over `choice`; listing it keeps the memo correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindings, filter, choice]);

  const selected = useMemo(
    () => bindings.find(b => b.key === selectedKey) ?? null,
    [bindings, selectedKey],
  );

  const siblings = selected?.source
    ? (duals.get(selected.source) ?? [])
        .filter(b => b.key !== selected.key)
        .map(b => b.key)
    : [];

  if (error) return <p className="err">Failed to load model: {error}</p>;

  const views: View[] = ['browse', 'graph', 'hierarchy', 'raw'];
  const labels: Record<View, string> = {
    browse: 'Explore',
    graph: 'Graph',
    hierarchy: 'Hierarchy',
    raw: 'Raw tree',
  };

  return (
    <ApiProvider value={api}>
      <header>
        <h1>{title}</h1>
        {model?.app.name && (
          <span className="appcard">
            {model.app.name}
            {model.app.version ? ` v${model.app.version}` : ''}
          </span>
        )}
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

      {view === 'hierarchy' && (
        <div style={{padding: '1.25rem 1.5rem', overflow: 'auto'}}>
          <HierarchyView
            contexts={model?.contexts ?? []}
            bindings={bindings}
            onSelect={setSelectedKey}
          />
        </div>
      )}

      {view === 'browse' && (
        <div className="shell">
          <FacetNav facets={allFacets} selected={choice} onPick={pick} />
          <div className="list">
            <input
              className="filter"
              placeholder="Filter by key…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            <ResultsList
              bindings={visible}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
            />
          </div>
          <div className="detail">
            <BindingDetail
              binding={selected}
              dependsOn={selected ? (dependsOn.get(selected.key) ?? []) : []}
              dependedOnBy={
                selected ? (dependedOnBy.get(selected.key) ?? []) : []
              }
              configuredBy={selected ? (cfgEdges.get(selected.key) ?? []) : []}
              extensions={
                selected?.extensionPoint
                  ? (extGroups.get(selected.extensionPoint) ?? []).map(
                      b => b.key,
                    )
                  : []
              }
              siblings={siblings}
              onSelect={setSelectedKey}
            />
          </div>
        </div>
      )}
    </ApiProvider>
  );
}
