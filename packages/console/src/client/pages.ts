// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Explicit panel registration (the chosen composition model — no build-time
// auto-discovery). Each tool ships a `./console` entry exporting `pages`; the
// console imports them here and concatenates. Add a panel by installing its
// package and adding one import + spread below. esbuild resolves these to the
// tools' source TSX, so they are bundled into the single console SPA.
import {pages as contextPages} from '@agentback/context-explorer/console';
import {pages as apiPages} from '@agentback/rest-explorer/console';
import {pages as mcpPages} from '@agentback/mcp-inspector/console';
import type {ConsolePage} from './types';

export const pages: ConsolePage[] = [...contextPages, ...apiPages, ...mcpPages];
