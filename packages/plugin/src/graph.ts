// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {PluginInfo, PluginLoadError} from './types.js';

export interface SortInput {
  /** Plugins that survived the gate, in discovery order. */
  gated: PluginInfo[];
  /** Plugins the gate dropped — used only to explain an unsatisfied inject. */
  skipped: PluginInfo[];
  /** Keys already bound on the app before `loadPlugins` ran. */
  appOwnedKeys: ReadonlySet<string>;
  /** Manifest `order:` — the tiebreaker among simultaneously-ready plugins. */
  order: string[];
  /** Keys a plugin may intentionally re-bind. */
  allowOverride: ReadonlySet<string>;
}

export interface GraphResult {
  ordered: PluginInfo[];
  errors: PluginLoadError[];
  warnings: string[];
}

/**
 * Order the gated set by `inject -> provides`, and reject a graph that cannot
 * be satisfied — all BEFORE any plugin is imported, which is the whole point:
 * the snapshot-diff collision check can only fire after `app.component()` has
 * already run its side effects.
 *
 *   gated ──► providers map ──► duplicate check ──► edges ──► Kahn ──► ordered
 *                    │                │                │         │
 *                    │                │                │         └─ leftover = cycle
 *                    │                │                └─ missing = unsatisfied
 *                    │                └─ two providers, no allowOverride
 *                    └─ appOwnedKeys satisfy WITHOUT an edge
 *
 * Determinism: Kahn's algorithm, and among nodes that become ready at the same
 * time the `order:` index wins, then discovery index. Never Map iteration
 * order. With zero declarations there are no edges, so every node is ready at
 * once and `order:` alone governs — which is exactly today's behaviour, and
 * what keeps this additive for existing apps.
 */
export function sortByGraph(input: SortInput): GraphResult {
  const {gated, skipped, appOwnedKeys, order, allowOverride} = input;
  const errors: PluginLoadError[] = [];
  const warnings: string[] = [];

  const discoveryIndex = new Map(gated.map((p, i) => [p.name, i]));
  const orderIndex = new Map(order.map((n, i) => [n, i]));
  const rank = (name: string): [number, number] => [
    orderIndex.get(name) ?? Number.MAX_SAFE_INTEGER,
    discoveryIndex.get(name) ?? Number.MAX_SAFE_INTEGER,
  ];

  // 1. Who provides what. A key claimed twice is a collision unless the
  //    manifest says the override is intentional — two plugins re-binding one
  //    key under `allowOverride` is a supported case today.
  // A key may legitimately have SEVERAL providers under `allowOverride`, and
  // every one of them must mount before a consumer — edging only to the last
  // declarer would let an earlier provider mount *after* the consumer and
  // overwrite the binding the consumer was ordered to wait for. So this maps
  // key -> ALL providers, and the edge builder consumes all of them.
  const providers = new Map<string, string[]>();
  const duplicates = new Map<string, string[]>();
  for (const p of gated) {
    for (const key of p.provides) {
      const prior = providers.get(key);
      if (prior !== undefined && !allowOverride.has(key)) {
        const list = duplicates.get(key) ?? [...prior];
        list.push(p.name);
        duplicates.set(key, list);
        continue;
      }
      if (prior === undefined) providers.set(key, [p.name]);
      else prior.push(p.name);
    }
  }
  for (const [key, names] of duplicates) {
    errors.push({
      package: names[names.length - 1],
      kind: 'duplicate-provides',
      message:
        `declares provides "${key}", already declared by ` +
        `${names.slice(0, -1).join(', ')}. List it in plugins.allowOverride ` +
        `if the override is intentional.`,
      collidingKeys: [key],
    });
  }
  if (errors.length) return {ordered: [], errors, warnings};

  // 2. Edges. A key the APP already bound satisfies an inject with no edge —
  //    not every dependency comes from a plugin, and that is what makes
  //    binding-keys-only workable.
  const skippedProviders = new Map<string, string>();
  for (const p of skipped) {
    for (const key of p.provides) skippedProviders.set(key, p.name);
  }

  const dependsOn = new Map<string, Set<string>>(
    gated.map(p => [p.name, new Set<string>()]),
  );
  for (const p of gated) {
    for (const key of p.inject) {
      if (appOwnedKeys.has(key)) continue;
      const provider = providers.get(key)?.[0];
      if (provider === undefined) {
        const gatedOut = skippedProviders.get(key);
        errors.push({
          package: p.name,
          kind: 'unsatisfied-inject',
          message: gatedOut
            ? `injects "${key}", provided by ${gatedOut}, which the manifest ` +
              `gate excluded (enable/disable).`
            : `injects "${key}", which no mounted plugin provides and the ` +
              `application has not bound. Declare it in a provider's ` +
              `"provides", bind it on the app before loadPlugins(), or drop ` +
              `it from this plugin's "inject".`,
        });
        continue;
      }
      // Edge to EVERY provider, not just one — see the providers map above.
      for (const name of providers.get(key)!) {
        if (name !== p.name) dependsOn.get(p.name)!.add(name);
      }
    }
  }
  if (errors.length) return {ordered: [], errors, warnings};

  // 3. Kahn, with a total deterministic tiebreak.
  const remaining = new Map(gated.map(p => [p.name, p]));
  const ordered: PluginInfo[] = [];
  while (remaining.size) {
    const ready: string[] = [];
    for (const name of remaining.keys()) {
      let blocked = false;
      for (const dep of dependsOn.get(name)!) {
        if (remaining.has(dep)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) ready.push(name);
    }
    if (!ready.length) break; // cycle
    ready.sort((a, b) => {
      const [ao, ad] = rank(a);
      const [bo, bd] = rank(b);
      return ao !== bo ? ao - bo : ad - bd;
    });
    const next = ready[0];
    ordered.push(remaining.get(next)!);
    remaining.delete(next);
  }

  if (remaining.size) {
    const names = [...remaining.keys()].sort();
    errors.push({
      package: names[0],
      kind: 'dependency-cycle',
      message:
        `is in a provides/inject cycle with: ${names.join(', ')}. ` +
        `Factor the shared dependency into its own plugin.`,
    });
    return {ordered: [], errors, warnings};
  }

  return {ordered, errors, warnings};
}
