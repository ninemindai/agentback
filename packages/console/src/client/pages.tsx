// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Explicit panel registration (the chosen composition model — no build-time
// auto-discovery). Each tool ships a `./console` entry exporting `pages`; the
// console imports them here and concatenates. Add a panel by installing its
// package and adding one import + spread below. esbuild resolves these to the
// tools' source TSX, so they are bundled into the single console SPA.
import {App as ContextApp} from '@agentback/context-explorer/client/App';
import {App as SchemaApp} from '@agentback/schema-explorer/client/App';
import {pages as apiPages} from '@agentback/rest-explorer/console';
import {pages as mcpPages} from '@agentback/mcp-inspector/console';
import {publishFocus} from './focus.js';
import type {ConsolePage} from './types.js';

const contextPages: ConsolePage[] = [
  {
    id: 'context',
    title: 'Context',
    icon: '◧',
    order: 10,
    route: '/context',
    liveRefresh: 'prop',
    component: ({apiBase, reloadNonce}: {apiBase: string; reloadNonce?: number}) => (
      <ContextApp
        apiBase={apiBase}
        title="Context Explorer"
        reloadNonce={reloadNonce}
        onFocusChange={key =>
          publishFocus(key ? {kind: 'binding', id: key} : null)
        }
      />
    ),
  },
];

const schemaPages: ConsolePage[] = [
  {
    id: 'schema',
    title: 'Schemas',
    icon: '◆',
    order: 40,
    route: '/schema',
    liveRefresh: 'prop',
    component: ({apiBase, reloadNonce}: {apiBase: string; reloadNonce?: number}) => (
      <SchemaApp
        apiBase={apiBase}
        title="Schema Explorer"
        reloadNonce={reloadNonce}
        onFocusChange={(id, label) =>
          publishFocus(id ? {kind: 'schema-entity', id, label} : null)
        }
      />
    ),
  },
];

export const pages: ConsolePage[] = [
  ...contextPages,
  ...schemaPages,
  ...apiPages,
  ...mcpPages,
];
