// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Application} from '@agentback/core';
import {PluginBindings, PluginsConfig} from './config.js';
import {applyGate} from './gate.js';
import {discover} from './discovery.js';
import {appOwnedContext, tryMount} from './mount.js';
import type {
  LoadPluginsOptions,
  PluginLoadError,
  PluginLoadReport,
} from './types.js';

function resolveConfig(app: Application, options: LoadPluginsOptions) {
  if (options.config !== undefined) return PluginsConfig.parse(options.config);
  if (app.isBound(PluginBindings.CONFIG.key)) {
    return PluginsConfig.parse(app.getSync(PluginBindings.CONFIG));
  }
  return PluginsConfig.parse(undefined);
}

/**
 * Discover, gate, and mount plugins into `app`. Fail-closed by default: an
 * import/export failure or a DI-key collision throws (and is recorded in the
 * returned report before throwing). Pass `strict: false` to collect & continue.
 */
export async function loadPlugins(
  app: Application,
  options: LoadPluginsOptions = {},
): Promise<PluginLoadReport> {
  const config = resolveConfig(app, options);
  const strict = options.strict ?? config.strict;
  const cwd = options.cwd ?? process.cwd();

  const warnings: string[] = [];
  const discovered = await discover(config, cwd, warnings);
  const gate = applyGate(discovered, config);
  warnings.push(...gate.warnings);

  const report: PluginLoadReport = {
    discovered,
    mounted: [],
    skipped: gate.skipped,
    warnings,
    errors: [],
  };

  const ctx = appOwnedContext(app, config.allowOverride);

  const fail = (err: PluginLoadError): void => {
    report.errors.push(err);
    if (strict) {
      const e = new Error(
        `[plugin:${err.package}] ${err.kind}: ${err.message}`,
      ) as Error & {report?: PluginLoadReport};
      e.report = report;
      throw e;
    }
  };

  for (const info of gate.ordered) {
    const err = await tryMount(app, info, ctx);
    if (err) {
      fail(err);
      continue;
    }
    report.mounted.push(info);
  }

  return report;
}
