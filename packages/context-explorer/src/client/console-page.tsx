// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

// Console page contribution. Imported (build-time) by @agentback/console's
// SPA bundle via the package's `./console` export. The component receives its
// apiBase from the console shell; standalone use goes through main.tsx instead.
import {App} from './App';

export const pages = [
  {
    id: 'context',
    title: 'Context',
    icon: '◧',
    order: 10,
    route: '/context',
    component: ({apiBase}: {apiBase: string}) => (
      <App apiBase={apiBase} title="Context Explorer" />
    ),
  },
];
