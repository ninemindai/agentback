// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Application, Component} from '@agentback/core';
import {PluginBindings, PluginsConfig} from './config.js';
import {applyGate} from './gate.js';
import {discover} from './discovery.js';
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
 * Snapshot key -> Binding INSTANCE for every binding in the context. Instance
 * identity (not just key presence) is what lets us detect an *override*:
 * `context.add()` does `registry.set(key, binding)`, so re-binding an existing
 * key keeps the key string but swaps the Binding object.
 */
function boundBindings(app: Application): Map<string, object> {
  return new Map(app.find().map(b => [b.key, b as object]));
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
  const allowOverride = new Set(config.allowOverride);

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

  const owners = new Map<string, string>();
  for (const key of boundBindings(app).keys()) owners.set(key, '<app>');

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
    let mod: Record<string, unknown>;
    try {
      mod = (await import(info.importSpecifier)) as Record<string, unknown>;
    } catch (err) {
      fail({package: info.name, kind: 'import', message: String(err)});
      continue;
    }

    const exported = mod[info.component];
    if (typeof exported !== 'function') {
      fail({
        package: info.name,
        kind: 'missing-export',
        message: `named export "${info.component}" is missing or not a class`,
      });
      continue;
    }

    const before = boundBindings(app);
    try {
      app.component(exported as new (...args: unknown[]) => Component);
    } catch (err) {
      fail({package: info.name, kind: 'import', message: String(err)});
      continue;
    }
    const after = boundBindings(app);

    const collisions: string[] = [];
    for (const [key, binding] of after) {
      const priorBinding = before.get(key);
      const touched = priorBinding === undefined || priorBinding !== binding;
      if (!touched) continue;
      const prior = owners.get(key);
      if (prior && prior !== info.name && !allowOverride.has(key)) {
        collisions.push(key);
      }
      owners.set(key, info.name);
    }
    if (collisions.length) {
      fail({
        package: info.name,
        kind: 'key-collision',
        message: `re-binds key(s) owned by another plugin: ${collisions.join(', ')}`,
        collidingKeys: collisions,
      });
      continue;
    }

    report.mounted.push(info);
  }

  return report;
}
