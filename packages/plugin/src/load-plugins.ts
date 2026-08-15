// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Application} from '@agentback/core';
import {PluginBindings, PluginsConfig} from './config.js';
import {applyGate} from './gate.js';
import {discover} from './discovery.js';
import {sortByGraph} from './graph.js';
import {
  appOwnedContext,
  buildTeardown,
  componentRefsFor,
  tryMount,
} from './mount.js';
import type {MountOutcome} from './mount.js';
import {entryFromInfo, pluginRegistryFor} from './registry.js';
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

  // `appOwnedContext` already snapshots every key bound before this call, so
  // it doubles as the "satisfied by the application itself" set — an inject
  // the app answers imposes no ordering constraint on any plugin.
  // Before the snapshot, so the registry is app-owned rather than part of
  // the first plugin's footprint.
  const refs = componentRefsFor(app);
  const registry = pluginRegistryFor(app, refs);
  const ctx = appOwnedContext(app, config.allowOverride);
  const graph = sortByGraph({
    gated: gate.ordered,
    skipped: gate.skipped,
    appOwnedKeys: new Set(ctx.owners.keys()),
    order: config.order,
    allowOverride: ctx.allowOverride,
  });
  warnings.push(...graph.warnings);

  const outcomes: MountOutcome[] = [];
  // Built LAZILY over the live `outcomes` array — eager construction would
  // snapshot an empty list, and the inverse has to cover whatever had mounted
  // when uninstall() is called, including a partial load that threw under
  // `strict`. MEMOIZED because `composeTeardown` is idempotent per instance:
  // rebuilding per call would re-run every disposer, decrementing component
  // refcounts a second time and unbinding a component another live plugin
  // still holds.
  // Memoize the PROMISE, not a function that builds one. `teardown ??= () =>
  // build()` would memoize the builder and re-invoke it on every call, which
  // is the same double-retraction this comment exists to prevent.
  let teardownRun: Promise<void> | undefined;
  const report: PluginLoadReport = {
    discovered,
    mounted: [],
    skipped: gate.skipped,
    warnings,
    errors: [],
    uninstall: () =>
      (teardownRun ??= buildTeardown(app, outcomes, refs)().finally(() => {
        for (const p of report.mounted) registry.remove(p.name);
      })),
  };

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

  // Graph errors are detected before ANY import, so a strict failure here
  // throws with zero mounts performed — unlike a collision, which the snapshot
  // diff can only catch after `app.component()` ran its side effects.
  for (const err of graph.errors) fail(err);

  for (const info of graph.ordered) {
    const outcome = await tryMount(app, info, ctx, refs);
    if (!outcome.ok) {
      fail(outcome.error);
      continue;
    }
    outcomes.push(outcome);
    registry.add(entryFromInfo(info));
    report.mounted.push(info);
  }

  return report;
}
