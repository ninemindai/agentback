// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/mcp-inspector
// This file is licensed under the MIT License.

// Console page contribution. Imported (build-time) by @agentback/console's
// SPA bundle via the package's `./console` export. The shell supplies apiBase
// and (when remote-connect is enabled) `extra.connect`; standalone use goes
// through main.tsx instead.
import {App} from './App';
import type {ConnectConfig} from './api';

export const pages = [
  {
    id: 'mcp',
    title: 'MCP',
    icon: '◆',
    order: 30,
    route: '/mcp',
    component: ({
      apiBase,
      extra,
    }: {
      apiBase: string;
      extra?: {connect?: ConnectConfig | null};
    }) => (
      <App
        apiBase={apiBase}
        title="MCP Inspector"
        connect={extra?.connect ?? null}
      />
    ),
  },
];
