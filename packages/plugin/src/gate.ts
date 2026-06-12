// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {PluginsConfigResolved} from './config.js';
import type {PluginInfo} from './types.js';

export interface GateResult {
  ordered: PluginInfo[];
  skipped: Array<PluginInfo & {reason: 'disabled' | 'not-enabled'}>;
  warnings: string[];
}

/**
 * Filter and order discovered candidates per the manifest.
 *
 *   discovered
 *     ├── enable present?  -> keep only enabled (rest: skipped 'not-enabled')
 *     ├── disable          -> drop (skipped 'disabled')
 *     └── order            -> listed names first (in order), remainder by discovery order
 */
export function applyGate(
  discovered: PluginInfo[],
  config: PluginsConfigResolved,
): GateResult {
  const warnings: string[] = [];
  const byName = new Map(discovered.map(p => [p.name, p]));
  const skipped: GateResult['skipped'] = [];

  const enableSet = config.enable ? new Set(config.enable) : null;
  const disableSet = new Set(config.disable);

  if (enableSet) {
    for (const name of enableSet) {
      if (!byName.has(name)) {
        warnings.push(`plugins.enable: "${name}" was not discovered`);
      }
    }
  }
  for (const name of config.order) {
    if (!byName.has(name)) {
      warnings.push(`plugins.order: "${name}" was not discovered`);
    }
  }

  let kept: PluginInfo[] = [];
  for (const p of discovered) {
    if (enableSet && !enableSet.has(p.name)) {
      skipped.push({...p, reason: 'not-enabled'});
      continue;
    }
    if (disableSet.has(p.name)) {
      skipped.push({...p, reason: 'disabled'});
      continue;
    }
    kept.push(p);
  }

  if (config.order.length) {
    const orderIndex = new Map(config.order.map((n, i) => [n, i]));
    const inOrder = kept
      .filter(p => orderIndex.has(p.name))
      .sort((a, b) => orderIndex.get(a.name)! - orderIndex.get(b.name)!);
    const rest = kept.filter(p => !orderIndex.has(p.name));
    kept = [...inOrder, ...rest];
  }

  return {ordered: kept, skipped, warnings};
}
