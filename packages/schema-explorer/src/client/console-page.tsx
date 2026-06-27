// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

// Console page contribution. Imported (build-time) by @agentback/console's SPA
// bundle via the package's `./console` export. The component receives its
// apiBase from the console shell; standalone use goes through main.tsx instead.
import {App} from './App';

export const pages = [
  {
    id: 'schema',
    title: 'Schemas',
    icon: '◆',
    order: 40,
    route: '/schema',
    component: ({apiBase}: {apiBase: string}) => (
      <App apiBase={apiBase} title="Schema Explorer" />
    ),
  },
];
