// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/console
// This file is licensed under the MIT License.

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import {pages} from './pages';
import type {ConsoleClientConfig} from './types';

const cfg: ConsoleClientConfig = (
  globalThis as unknown as {__CONSOLE__?: ConsoleClientConfig}
).__CONSOLE__ ?? {basePath: '/console', title: 'console', panels: {}};

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App config={cfg} pages={pages} />
    </StrictMode>,
  );
}
