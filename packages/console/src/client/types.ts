// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ComponentType} from 'react';

/** Props every console panel receives from the shell. */
export interface ConsolePanelProps {
  /** The panel's JSON API base (from its server ConsoleFeature). */
  apiBase: string;
  /** Optional per-panel config (e.g. the inspector's connect, Swagger's url). */
  extra?: Record<string, unknown>;
}

/**
 * A panel contributed to the console. Authored with {@link defineConsolePage}
 * in a tool's `./console` entry; the console's `pages.ts` imports and lists it.
 */
export interface ConsolePage {
  id: string;
  title: string;
  /** Sidebar glyph; pages without an `icon` are routable but hidden from nav. */
  icon?: string;
  /** Sidebar sort key (10-spacing leaves room to insert between tools). */
  order: number;
  /** Client route under the console base, e.g. `/context`. */
  route: string;
  component: ComponentType<ConsolePanelProps>;
}

/** Identity helper for authoring a page with inferred types. */
export function defineConsolePage(page: ConsolePage): ConsolePage {
  return page;
}

/** Server-injected config the shell reads off `window.__CONSOLE__`. */
export interface ConsoleClientConfig {
  basePath: string;
  title: string;
  panels: Record<string, {apiBase: string; extra?: Record<string, unknown>}>;
}
