// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';

interface ExplorerConfig {
  apiBase: string;
  title: string;
}
const cfg: ExplorerConfig = (
  globalThis as unknown as {__SCHEMA_EXPLORER__?: ExplorerConfig}
).__SCHEMA_EXPLORER__ ?? {
  apiBase: '/schema-explorer/api',
  title: 'Schema Explorer',
};

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App apiBase={cfg.apiBase} title={cfg.title} />
    </StrictMode>,
  );
}
