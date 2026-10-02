// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  resourceFragment,
  type JsonValue,
  type ResourceFragment,
} from '@agentback/mcp';
import type {OpenAIDisplayMode} from './entrypoints.js';
import {OPENAI_UI_META_KEY} from './shared.js';

const MODES: readonly string[] = ['inline', 'fullscreen'];

/**
 * The display modes a widget supports in ChatGPT, on its `resources/read`
 * content item (`_meta["openai/ui"]`): `preferred` is the first render's
 * mode, `available` every mode it can take. ChatGPT supports `inline` and
 * `fullscreen`; `pip` is refused. `preferred` must be among `available`.
 *
 * @example
 *   @appResource('ui://bits/library', {
 *     extend: [displayModes({preferred: 'fullscreen'})],
 *   })
 *
 * @experimental Tracks OpenAI's MCP extensions spec (0.1.x).
 */
export function displayModes(options: {
  preferred?: OpenAIDisplayMode;
  available?: OpenAIDisplayMode[];
}): ResourceFragment {
  const {preferred, available} = options;
  for (const m of [...(available ?? []), ...(preferred ? [preferred] : [])]) {
    if (!MODES.includes(m)) {
      throw new Error(
        `displayModes: '${m}' is not a ChatGPT display mode (inline, fullscreen)`,
      );
    }
  }
  if (available && available.length === 0) {
    throw new Error('displayModes: available needs at least one mode');
  }
  if (preferred && available && !available.includes(preferred)) {
    throw new Error(
      `displayModes: preferred '${preferred}' is not among available`,
    );
  }
  if (!preferred && !available) {
    throw new Error('displayModes: set preferred, available, or both');
  }
  const value: Record<string, JsonValue> = {};
  if (available) value.availableDisplayModes = [...new Set(available)];
  if (preferred) value.preferredDisplayMode = preferred;
  return resourceFragment({meta: {[OPENAI_UI_META_KEY]: value}});
}
