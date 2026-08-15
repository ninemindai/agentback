// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Application} from '@agentback/core';
import type {ComponentEntry} from './mount.js';
import type {PluginInfo} from './types.js';

/** One live mount, as reported by {@link PluginRegistry}. */
export interface MountedPlugin {
  name: string;
  version: string;
  component: string;
  /** `memory` is a class mounted at runtime, with no package behind it. */
  source: 'deps' | 'dir' | 'memory';
  provides: string[];
  inject: string[];
}

/**
 * What is mounted right now, and what the component refcounts are.
 *
 * `loadPlugins` returns a `PluginLoadReport`, which is the record of ONE
 * discovery run. This is the live state instead: it spans every entry point,
 * loses entries as plugins retract, and is readable by anything holding the
 * app — an operator, the console, or an agent inspecting the tree it is about
 * to change.
 */
export interface PluginRegistry {
  /** Every plugin currently mounted, in mount order. */
  mounted(): MountedPlugin[];
  /** `components.*` key -> how many live mounts reference it. */
  componentRefs(): ReadonlyMap<string, number>;
}

/** The mutable half, used by the loader; never handed to callers. */
export interface MutablePluginRegistry extends PluginRegistry {
  add(entry: MountedPlugin): void;
  remove(name: string): void;
}

export function createPluginRegistry(
  refs: Map<string, ComponentEntry>,
): MutablePluginRegistry {
  const entries = new Map<string, MountedPlugin>();
  return {
    mounted: () => [...entries.values()],
    componentRefs: () =>
      new Map([...refs].map(([key, entry]) => [key, entry.count])),
    add: entry => entries.set(entry.name, entry),
    remove: name => entries.delete(name),
  };
}

/** Build a registry entry from a discovered plugin. */
export function entryFromInfo(info: PluginInfo): MountedPlugin {
  return {
    name: info.name,
    version: info.version,
    component: info.component,
    source: info.source,
    provides: info.provides,
    inject: info.inject,
  };
}

/**
 * Resolve the app's registry, creating and binding it on first use.
 *
 * MUST be called outside any mount window. The loader snapshots bindings
 * around `app.component()` to build a plugin's retraction footprint, so a
 * registry bound inside that window would become part of the first plugin's
 * footprint — and retracting that plugin would unbind the registry out from
 * under every other mount.
 */
export function pluginRegistryFor(
  app: Application,
  refs: Map<string, ComponentEntry>,
): MutablePluginRegistry {
  const key = 'plugins.registry';
  if (app.isBound(key)) return app.getSync<MutablePluginRegistry>(key);
  const registry = createPluginRegistry(refs);
  app.bind(key).to(registry);
  return registry;
}
