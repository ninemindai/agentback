// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {useCallback, useEffect, useMemo, useState} from 'react';
import {makeApi, type SchemaNode} from './api';
import {ApiProvider} from './ApiContext';
import {SchemaList} from './components/SchemaList';
import {SchemaDetail} from './components/SchemaDetail';
import {SchemaGraphView} from './components/SchemaGraphView';
import {OkfView} from './components/OkfView';

type View = 'browse' | 'graph' | 'okf';

/**
 * Schema explorer root. Indexes the app's domain schemas: a filterable catalog
 * (browse) backed by a per-entity provenance detail, plus a graph view wiring
 * each schema to the routes/tools that use it. `apiBase` is injected so the
 * panel works standalone and inside the unified console.
 *
 * `onFocusChange` — optional callback fired when the selected schema changes
 * (null on deselect). Used by the console shell's focus bus.
 */
export function App({
  apiBase,
  title = 'Schema Explorer',
  reloadNonce = 0,
  onFocusChange,
}: {
  apiBase: string;
  title?: string;
  /** Bumped by the console shell when the app restarts; refetch on change. */
  reloadNonce?: number;
  /** Called with the selected schema id, or null when nothing is selected. */
  onFocusChange?: (id: string | null, label?: string) => void;
}) {
  const api = useMemo(() => makeApi(apiBase), [apiBase]);
  const [nodes, setNodes] = useState<SchemaNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<View>('browse');
  // Non-fatal: a refetch after a restart failed (app mid-restart). Keep stale
  // data visible rather than blanking the panel.
  const [reloadError, setReloadError] = useState(false);

  const load = useCallback(
    () =>
      api.fetchSchemas().then(
        n => {
          setNodes(n);
          setReloadError(false);
        },
        e => setError(String(e)),
      ),
    [api],
  );

  // Initial load (and on apiBase change).
  useEffect(() => {
    load();
  }, [load]);

  // Live reflection: refetch on restart; keep stale data on failure.
  useEffect(() => {
    if (reloadNonce === 0) return;
    api.fetchSchemas().then(
      n => {
        setNodes(n);
        setReloadError(false);
      },
      () => setReloadError(true),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce]);

  useEffect(() => {
    if (!onFocusChange) return;
    const node = nodes.find(n => n.id === selectedId);
    onFocusChange(selectedId, node?.name);
    return () => onFocusChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? nodes.filter(
          n =>
            n.name.toLowerCase().includes(q) ||
            n.origin?.table?.toLowerCase().includes(q) ||
            n.usages.some(u => u.ref.toLowerCase().includes(q)),
        )
      : nodes;
    // Registered schemas first, then by name — stable, scannable order.
    return [...list].sort(
      (a, b) =>
        Number(b.bound) - Number(a.bound) || a.name.localeCompare(b.name),
    );
  }, [nodes, filter]);

  const selected = useMemo(
    () => nodes.find(n => n.id === selectedId) ?? null,
    [nodes, selectedId],
  );

  if (error) {
    return (
      <div className="schemax">
        <div className="err">{error}</div>
      </div>
    );
  }

  return (
    <ApiProvider value={api}>
      <div className="schemax">
        <header>
          <h1>{title}</h1>
          <span className="count">{nodes.length} schemas</span>
          {reloadError && (
            <span className="count" title="Could not refresh after restart">
              ⚠ stale
            </span>
          )}
          <div className="views">
            <button
              className={'btn' + (view === 'browse' ? '' : ' ghost')}
              onClick={() => setView('browse')}
            >
              Browse
            </button>
            <button
              className={'btn' + (view === 'graph' ? '' : ' ghost')}
              onClick={() => setView('graph')}
            >
              Graph
            </button>
            <button
              className={'btn' + (view === 'okf' ? '' : ' ghost')}
              onClick={() => setView('okf')}
            >
              Knowledge
            </button>
          </div>
        </header>

        {view === 'okf' ? (
          <OkfView />
        ) : view === 'graph' ? (
          <div className="graphpane">
            <SchemaGraphView selectedId={selectedId} onSelect={setSelectedId} />
          </div>
        ) : (
          <div className="layout">
            <div className="list">
              <input
                className="filter"
                placeholder="Filter by name, table, or route…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
              />
              <SchemaList
                nodes={visible}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            </div>
            <div className="detail">
              {selected ? (
                <SchemaDetail node={selected} />
              ) : (
                <div className="empty">Select a schema to inspect it.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </ApiProvider>
  );
}
