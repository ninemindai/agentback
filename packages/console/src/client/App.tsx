// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/console
// This file is licensed under the MIT License.

import type {ComponentType} from 'react';
import {useEffect, useMemo, useState} from 'react';
import type {ConsoleClientConfig, ConsolePage} from './types.js';
import {startLiveBus, subscribeReload, subscribeStatus} from './live.js';

/** Props forwarded to the dock component (mirrors `ConsoleClientConfig.chat`). */
export type ChatConfig = NonNullable<ConsoleClientConfig['chat']>;

/**
 * Console shell: a left sidebar (nav derived from the registered pages, sorted
 * by `order`) + a content pane rendering the active panel.  When
 * `config.chat?.enabled` is true a third dock column is added on the right.
 * Routing is hash-based (`#/context`) — dependency-free and deep-linkable, no
 * server routes needed beyond the static shell.
 *
 * The `DockComponent` prop lets the SPA entry point (`main.tsx`) inject the
 * real `Dock` from `@agentback/console-chat/console` without this file taking
 * a compile-time dependency on that package (avoids a circular dep).
 */
export function App({
  config,
  pages,
  DockComponent,
}: {
  config: ConsoleClientConfig;
  pages: ConsolePage[];
  DockComponent?: ComponentType<{chat: ChatConfig; dockOpen: boolean; onToggleDock: () => void}>;
}) {
  const nav = useMemo(
    () => [...pages].sort((a, b) => a.order - b.order),
    [pages],
  );
  const routeOf = () =>
    (typeof window !== 'undefined'
      ? window.location.hash.replace(/^#/, '')
      : '') || nav[0]?.route;
  const [route, setRoute] = useState(routeOf);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHash = () => setRoute(routeOf());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // nav is stable for the lifetime of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = nav.find(p => p.route === route) ?? nav[0];
  const chatEnabled = config.chat?.enabled === true;
  const [dockOpen, setDockOpen] = useState(false);
  const onToggleDock = () => setDockOpen(o => !o);

  const [reloadNonce, setReloadNonce] = useState(0);
  const [live, setLive] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stop = startLiveBus(config.basePath + '/live');
    const offReload = subscribeReload(() => setReloadNonce(n => n + 1));
    const offStatus = subscribeStatus(setLive);
    return () => {
      offReload();
      offStatus();
      stop();
    };
  }, [config.basePath]);

  return (
    <div className={chatEnabled ? 'console console--chat' : 'console'}>
      <aside className="sidebar">
        <div className="brand">{config.title}</div>
        {!live && (
          <div className="live-offline" title="Disconnected from the app">
            ● offline
          </div>
        )}
        <nav>
          {nav
            .filter(p => p.icon)
            .map(p => (
              <a
                key={p.id}
                href={'#' + p.route}
                className={p === active ? 'active' : ''}
              >
                <span className="icon">{p.icon}</span>
                {p.title}
              </a>
            ))}
        </nav>
      </aside>
      <main className="panel">
        {active ? (
          <Panel page={active} config={config} reloadNonce={reloadNonce} />
        ) : (
          <p className="empty" style={{padding: '2rem'}}>
            No panels registered.
          </p>
        )}
      </main>
      {chatEnabled && config.chat && (
        <>
          {/* Toggle tab — a SIBLING of `.dock`, never inside it: a position:fixed
              control inside the transformed `.dock` would slide off-screen with
              it. Pinned to the right edge; shifts to the panel's left edge when
              open (doubling as the close affordance). */}
          <button
            type="button"
            className={dockOpen ? 'dock-toggle dock-toggle--open' : 'dock-toggle'}
            onClick={onToggleDock}
            aria-label={dockOpen ? 'Close agent chat' : 'Open agent chat'}
            aria-expanded={dockOpen}
          >
            {dockOpen ? '› close' : '‹ Chat'}
          </button>
          <section
            className={dockOpen ? 'dock dock--open' : 'dock'}
            data-dock
            aria-hidden={!dockOpen}
          >
            {DockComponent && (
              <DockComponent
                chat={config.chat}
                dockOpen={dockOpen}
                onToggleDock={onToggleDock}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Panel({
  page,
  config,
  reloadNonce,
}: {
  page: ConsolePage;
  config: ConsoleClientConfig;
  reloadNonce: number;
}) {
  const panel = config.panels[page.id] ?? {apiBase: ''};
  const Component = page.component;
  // 'prop' panels refetch in place (selection preserved); all others remount
  // via key so a reload gives them a fresh fetch.
  if (page.liveRefresh === 'prop') {
    return (
      <Component
        apiBase={panel.apiBase}
        extra={panel.extra}
        reloadNonce={reloadNonce}
      />
    );
  }
  return (
    <Component
      key={page.id + ':' + reloadNonce}
      apiBase={panel.apiBase}
      extra={panel.extra}
    />
  );
}
