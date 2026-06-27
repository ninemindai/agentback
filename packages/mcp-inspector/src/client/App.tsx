// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  localApi,
  listTargets,
  remoteApi,
  type ConnectConfig,
  type HistoryEntry,
  type Manifest,
  type Outcome,
  type RemoteTarget,
} from './api';
import {ApiProvider} from './ApiContext';
import {ToolCard} from './components/ToolCard';
import {ResourceCard} from './components/ResourceCard';
import {PromptCard} from './components/PromptCard';
import {HistoryPanel} from './components/HistoryPanel';
import {ConnectBar} from './components/ConnectBar';

type SectionKey = 'tools' | 'resources' | 'prompts';

/**
 * Inspector root. `apiBase` targets the in-process MCP server; `connect`
 * (when present) enables remote-connect mode. Both are supplied by the
 * standalone shell or the console, so the panel is mount-agnostic.
 */
export function App({
  apiBase,
  connect = null,
  title = 'MCP Inspector',
}: {
  apiBase: string;
  connect?: ConnectConfig | null;
  title?: string;
}) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    tools: true,
    resources: true,
    prompts: true,
  });
  // Tool cards are open by default; a name present here is collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const nextId = useRef(1);

  // Active target: 'local' (in-process server) or a remote mcp-connect id.
  const [target, setTarget] = useState('local');
  const [targets, setTargets] = useState<RemoteTarget[]>([]);

  const api = useMemo(
    () =>
      target === 'local' || !connect
        ? localApi(apiBase)
        : remoteApi(connect.base, target),
    [target, apiBase, connect],
  );

  const refreshTargets = useCallback(async () => {
    if (!connect) return;
    setTargets(await listTargets(connect.base).catch(() => []));
  }, [connect]);

  useEffect(() => {
    refreshTargets();
  }, [refreshTargets]);

  // (Re)load the manifest whenever the active target changes.
  useEffect(() => {
    setManifest(null);
    setError(null);
    let live = true;
    api.fetchManifest().then(
      m => live && setManifest(m),
      e => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, [api]);

  function record(kind: HistoryEntry['kind'], name: string, outcome: Outcome) {
    const entry: HistoryEntry = {
      id: nextId.current++,
      at: new Date().toLocaleTimeString(),
      kind,
      name,
      outcome,
    };
    setHistory(h => [entry, ...h].slice(0, 100));
  }

  const toggleSection = (k: SectionKey) => setOpen(s => ({...s, [k]: !s[k]}));

  const toggleTool = (name: string) =>
    setCollapsed(s => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const tools = useMemo(() => {
    if (!manifest) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return manifest.tools;
    return manifest.tools.filter(
      t =>
        t.name.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q),
    );
  }, [manifest, filter]);

  const allCollapsed =
    tools.length > 0 && tools.every(t => collapsed.has(t.name));
  const setAllTools = (collapse: boolean) =>
    setCollapsed(s => {
      const next = new Set(s);
      for (const t of tools) {
        if (collapse) next.add(t.name);
        else next.delete(t.name);
      }
      return next;
    });

  return (
    <ApiProvider value={api}>
      <header>
        <h1>{title}</h1>
        {manifest && (
          <span className="server">
            {manifest.server.name} v{manifest.server.version}
          </span>
        )}
        {connect && (
          <ConnectBar
            connectBase={connect.base}
            active={target}
            targets={targets}
            onSelect={setTarget}
            onTargetsChanged={refreshTargets}
          />
        )}
        <input
          className="filter"
          placeholder="Filter tools…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <button className="ghost" onClick={() => setShowHistory(s => !s)}>
          History ({history.length})
        </button>
      </header>

      {error ? (
        <main>
          <p className="banner">Failed to load: {error}</p>
        </main>
      ) : !manifest ? (
        <main>
          <p className="empty">Loading…</p>
        </main>
      ) : (
        <main>
          <section>
            <SectionHead
              label="Tools"
              count={tools.length}
              total={manifest.tools.length}
              isOpen={open.tools}
              onToggle={() => toggleSection('tools')}
            >
              {tools.length > 0 && (
                <button
                  className="ghost"
                  onClick={e => {
                    e.stopPropagation();
                    setAllTools(!allCollapsed);
                  }}
                >
                  {allCollapsed ? 'expand all' : 'collapse all'}
                </button>
              )}
            </SectionHead>
            {open.tools &&
              (tools.length === 0 ? (
                <p className="empty">No tools match.</p>
              ) : (
                tools.map(t => (
                  <ToolCard
                    key={t.name}
                    tool={t}
                    record={record}
                    open={!collapsed.has(t.name)}
                    onToggleOpen={() => toggleTool(t.name)}
                  />
                ))
              ))}
          </section>

          <section>
            <SectionHead
              label="Resources"
              count={manifest.resources.length}
              isOpen={open.resources}
              onToggle={() => toggleSection('resources')}
            />
            {open.resources &&
              (manifest.resources.length === 0 ? (
                <p className="empty">No resources.</p>
              ) : (
                manifest.resources.map(r => (
                  <ResourceCard key={r.name} resource={r} record={record} />
                ))
              ))}
          </section>

          <section>
            <SectionHead
              label="Prompts"
              count={manifest.prompts.length}
              isOpen={open.prompts}
              onToggle={() => toggleSection('prompts')}
            />
            {open.prompts &&
              (manifest.prompts.length === 0 ? (
                <p className="empty">No prompts.</p>
              ) : (
                manifest.prompts.map(p => (
                  <PromptCard key={p.name} prompt={p} record={record} />
                ))
              ))}
          </section>
        </main>
      )}

      {showHistory && (
        <HistoryPanel entries={history} onClose={() => setShowHistory(false)} />
      )}
    </ApiProvider>
  );
}

function SectionHead({
  label,
  count,
  total,
  isOpen,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  total?: number;
  isOpen: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const countText =
    total != null && total !== count ? `${count} / ${total}` : `${count}`;
  return (
    <h2 className="section-head" onClick={onToggle}>
      <span className="fold">{isOpen ? '▾' : '▸'}</span>
      {label} ({countText}){children}
    </h2>
  );
}
