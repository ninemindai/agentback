// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/console
// This file is licensed under the MIT License.

import {useEffect, useMemo, useState} from 'react';
import type {ConsoleClientConfig, ConsolePage} from './types';

/**
 * Console shell: a left sidebar (nav derived from the registered pages, sorted
 * by `order`) + a content pane rendering the active panel. Routing is
 * hash-based (`#/context`) — dependency-free and deep-linkable, no server
 * routes needed beyond the static shell.
 */
export function App({
  config,
  pages,
}: {
  config: ConsoleClientConfig;
  pages: ConsolePage[];
}) {
  const nav = useMemo(
    () => [...pages].sort((a, b) => a.order - b.order),
    [pages],
  );
  const routeOf = () => window.location.hash.replace(/^#/, '') || nav[0]?.route;
  const [route, setRoute] = useState(routeOf);

  useEffect(() => {
    const onHash = () => setRoute(routeOf());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // nav is stable for the lifetime of the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = nav.find(p => p.route === route) ?? nav[0];

  return (
    <div className="console">
      <aside className="sidebar">
        <div className="brand">{config.title}</div>
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
          <Panel key={active.id} page={active} config={config} />
        ) : (
          <p className="empty" style={{padding: '2rem'}}>
            No panels registered.
          </p>
        )}
      </main>
    </div>
  );
}

function Panel({
  page,
  config,
}: {
  page: ConsolePage;
  config: ConsoleClientConfig;
}) {
  const panel = config.panels[page.id] ?? {apiBase: ''};
  const Component = page.component;
  return <Component apiBase={panel.apiBase} extra={panel.extra} />;
}
