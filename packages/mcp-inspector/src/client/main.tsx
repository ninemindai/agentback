// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './App';
import type {ConnectConfig} from './api';

interface InspectorConfig {
  apiBase: string;
  title: string;
  connect?: ConnectConfig | null;
}
const cfg: InspectorConfig = (
  globalThis as unknown as {__MCP_INSPECTOR__?: InspectorConfig}
).__MCP_INSPECTOR__ ?? {apiBase: '/mcp-inspector/api', title: 'MCP Inspector'};

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App
        apiBase={cfg.apiBase}
        title={cfg.title}
        connect={cfg.connect ?? null}
      />
    </StrictMode>,
  );
}
