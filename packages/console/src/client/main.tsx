// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/console
// This file is licensed under the MIT License.

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App.js';
import {pages} from './pages.js';
import type {ConsoleClientConfig} from './types.js';
import type {ComponentType} from 'react';
import type {ChatConfig} from './App.js';

const cfg: ConsoleClientConfig = (
  globalThis as unknown as {__CONSOLE__?: ConsoleClientConfig}
).__CONSOLE__ ?? {basePath: '/console', title: 'console', panels: {}};

// Lazily load the Dock component only when chat is enabled.  This is a
// build-time-only dynamic import in the esbuild bundle; `@agentback/console`
// does NOT list console-chat as a runtime dep (only as a devDep for the SPA
// bundle, which avoids a pnpm circular-dep at the server level).
let DockComponent: ComponentType<{chat: ChatConfig; dockOpen: boolean; onToggleDock: () => void}> | undefined;
if (cfg.chat?.enabled) {
  try {
    // esbuild statically inlines this into main.js at bundle time — the Dock
    // code is present in the bundle; it simply isn't rendered unless `config.chat?.enabled`.
    const mod = await import('@agentback/console-chat/console');
    DockComponent = mod.Dock;
  } catch {
    // console-chat not installed — dock stays absent.
  }
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App config={cfg} pages={pages} DockComponent={DockComponent} />
    </StrictMode>,
  );
}
