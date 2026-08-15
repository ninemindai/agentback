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

/** One live consumer blocking a retraction, and the key it needs. */
export interface RetractionBlocker {
  consumer: string;
  key: string;
  provider: string;
}

/**
 * Thrown when retracting a plugin would leave a live consumer resolving a key
 * nothing provides.
 */
export class PluginRetractionBlockedError extends Error {
  constructor(readonly blockers: RetractionBlocker[]) {
    const lines = blockers.map(
      b => `${b.consumer} injects "${b.key}", provided by ${b.provider}`,
    );
    super(
      `cannot retract: ${lines.join('; ')}. Uninstall the consumer first, or ` +
        `retract both through the report that mounted them.`,
    );
    this.name = 'PluginRetractionBlockedError';
  }
}

/**
 * A provider must outlive its consumers.
 *
 * A consumer's own teardown routinely needs the dependency it is losing:
 * closing a pool means handing connections back to whatever provided them. So
 * retracting a provider out from under a live consumer is not merely untidy,
 * it can break that consumer's cleanup.
 *
 * LIFO composition already gives this ordering WITHIN one report, because the
 * graph mounts providers first and the inverse replays in reverse. It gives
 * nothing across independent handles, which is what this guards.
 *
 * Fail-closed, matching how this package treats every other ordering problem:
 * a duplicate `provides`, an unsatisfiable `inject`, and a cycle all stop with
 * the plugins named. The escape hatch is to retract the consumer too.
 *
 * Reads the same advisory declarations as the rest of the graph, so an
 * under-declared `inject` is invisible here. Closing that would mean resolving
 * the container at teardown time to discover real edges, which is a different
 * and much larger design.
 */
export function assertRetractable(
  registry: PluginRegistry,
  retracting: ReadonlySet<string>,
): void {
  const mounted = registry.mounted();
  const goingAway = new Map<string, string>();
  for (const m of mounted) {
    if (!retracting.has(m.name)) continue;
    for (const key of m.provides) goingAway.set(key, m.name);
  }
  if (!goingAway.size) return;

  const blockers: RetractionBlocker[] = [];
  for (const m of mounted) {
    if (retracting.has(m.name)) continue; // leaving in the same breath
    for (const key of m.inject) {
      const provider = goingAway.get(key);
      if (provider) blockers.push({consumer: m.name, key, provider});
    }
  }
  if (blockers.length) throw new PluginRetractionBlockedError(blockers);
}
