// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Application, Component} from '@agentback/core';
import type {PluginInfo, PluginLoadError} from './types.js';

/**
 * Snapshot key -> Binding INSTANCE for every binding in the context. Instance
 * identity (not just key presence) is what lets us detect an *override*:
 * `context.add()` does `registry.set(key, binding)`, so re-binding an existing
 * key keeps the key string but swaps the Binding object.
 */
export function boundBindings(app: Application): Map<string, object> {
  return new Map(app.find().map(b => [b.key, b as object]));
}

/**
 * Per-load ledger threaded across mounts. `owners` maps each bound DI key to
 * the name of the plugin (or `<app>`) that owns it; `allowOverride` lists keys
 * a later mount may intentionally re-bind without it counting as a collision.
 */
export interface MountContext {
  owners: Map<string, string>;
  allowOverride: Set<string>;
}

/** Initialize a `MountContext` treating every already-bound key as app-owned. */
export function appOwnedContext(
  app: Application,
  allowOverride: Iterable<string> = [],
): MountContext {
  const owners = new Map<string, string>();
  for (const key of boundBindings(app).keys()) owners.set(key, '<app>');
  return {owners, allowOverride: new Set(allowOverride)};
}

/**
 * Import a resolved plugin, mount its `Component` via `app.component()`, and
 * detect DI-key collisions against `ctx`. Returns a `PluginLoadError` (without
 * throwing) on any failure so callers choose their own fail policy; mutates
 * `ctx.owners` for every key this mount touches.
 */
export async function tryMount(
  app: Application,
  info: PluginInfo,
  ctx: MountContext,
): Promise<PluginLoadError | null> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(info.importSpecifier)) as Record<string, unknown>;
  } catch (err) {
    return {package: info.name, kind: 'import', message: String(err)};
  }

  const exported = mod[info.component];
  if (typeof exported !== 'function') {
    return {
      package: info.name,
      kind: 'missing-export',
      message: `named export "${info.component}" is missing or not a class`,
    };
  }

  const before = boundBindings(app);
  try {
    app.component(exported as new (...args: unknown[]) => Component);
  } catch (err) {
    return {package: info.name, kind: 'import', message: String(err)};
  }
  const after = boundBindings(app);

  const collisions: string[] = [];
  for (const [key, binding] of after) {
    const priorBinding = before.get(key);
    const touched = priorBinding === undefined || priorBinding !== binding;
    if (!touched) continue;
    const prior = ctx.owners.get(key);
    if (prior && prior !== info.name && !ctx.allowOverride.has(key)) {
      collisions.push(key);
    }
    ctx.owners.set(key, info.name);
  }
  if (collisions.length) {
    return {
      package: info.name,
      kind: 'key-collision',
      message: `re-binds key(s) owned by another plugin: ${collisions.join(', ')}`,
      collidingKeys: collisions,
    };
  }

  return null;
}
