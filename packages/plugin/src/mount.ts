// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Binding} from '@agentback/context';
import {composeTeardown} from '@agentback/common';
import type {Application, Component, LifeCycleObserverRegistry} from '@agentback/core';
import {CoreBindings, CoreTags, revertOwned} from '@agentback/core';
import type {PluginInfo, PluginLoadError} from './types.js';

/**
 * Snapshot key -> Binding INSTANCE for every binding in the context. Instance
 * identity (not just key presence) is what lets us detect an *override*:
 * `context.add()` does `registry.set(key, binding)`, so re-binding an existing
 * key keeps the key string but swaps the Binding object. It is also what makes
 * the diff a usable retraction footprint — `before.get(key)` IS the binding
 * this mount displaced, which the `fromComponent` provenance tag can never
 * report (it is last-wins, so it names only the survivor).
 */
export function boundBindings(
  app: Application,
): Map<string, Readonly<Binding>> {
  return new Map(app.find().map(b => [b.key, b]));
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

/** One binding this mount added or replaced, and what it displaced. */
export interface TouchedBinding {
  binding: Readonly<Binding>;
  displaced?: Readonly<Binding>;
}

/** One mount's retraction footprint. */
export interface MountFootprint {
  /**
   * Bindings attributable to no shared component — retracted with this mount,
   * unconditionally.
   */
  ownTouched: TouchedBinding[];
  /**
   * Every `components.*` key this plugin REFERENCES — including nested
   * components it did not bind because `app.component()` early-returned.
   * Refcounted; the component's own bindings are retracted by whichever mount
   * drops its count to zero, which is NOT necessarily the mount that created
   * them.
   */
  componentKeys: string[];
}

/**
 * One shared component's live state: how many mounts reference it, and the
 * bindings it contributed (recorded once, by the mount that actually created
 * them).
 *
 * The bindings have to live HERE rather than on a mount's footprint. When two
 * plugins list the same nested component, `app.component()` early-returns for
 * the second, so only the FIRST mount's diff contains those bindings — while
 * the one that must retract them is whichever uninstalls LAST. Attaching them
 * to the component instead of to a plugin is what makes both ends work.
 */
interface ComponentEntry {
  count: number;
  touched: TouchedBinding[];
}

export type MountOutcome =
  | {ok: true; footprint: MountFootprint}
  | {ok: false; error: PluginLoadError};

/**
 * Component refcounts, shared per Application.
 *
 * This CANNOT be per-`loadPlugins`-run. Two independent `loadPlugin` calls
 * into the same app are two separate handles, and if each kept its own counts
 * then two plugins sharing a nested component would each see a count of 1 —
 * so whichever uninstalled first would unbind a component the other still
 * references. Keying on the app is what makes separate install handles
 * composable. A `WeakMap` keeps this off the DI container and lets it die
 * with the app.
 */
const componentRefs = new WeakMap<Application, Map<string, ComponentEntry>>();

/** The per-app component registry, created on first use. */
export function componentRefsFor(
  app: Application,
): Map<string, ComponentEntry> {
  let refs = componentRefs.get(app);
  if (!refs) {
    refs = new Map<string, ComponentEntry>();
    componentRefs.set(app, refs);
  }
  return refs;
}

/**
 * Which component's lifetime governs this binding: its own key when it IS a
 * component, otherwise the component that contributed it.
 *
 * This is the one job the `fromComponent` provenance tag is right for. It
 * cannot be the footprint (a constructor that binds directly is untagged, and
 * last-wins provenance never names a displaced binding) — but for "which
 * component owns this binding", it is exactly the attribution needed, and it
 * is stamped as the owning component's BINDING KEY, the same shape
 * `componentKeys` holds.
 */
function owningComponent(
  binding: Readonly<Binding>,
  componentKeys: ReadonlySet<string>,
): string | undefined {
  if (componentKeys.has(binding.key)) return binding.key;
  const tag = binding.tagMap[CoreTags.FROM_COMPONENT] as string | undefined;
  return tag !== undefined && componentKeys.has(tag) ? tag : undefined;
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
 * Every `components.*` key a mounted component tree references.
 *
 * This CANNOT come from the binding diff. `app.component()` early-returns when
 * the key is already bound to the same constructor, so when a second plugin
 * lists a nested component the first one already mounted, the second's diff is
 * empty for it — and retracting the first would silently break the second.
 * Walk the resolved instance's `.components` tree instead, which reports the
 * reference whether or not this mount created the binding.
 */
function referencedComponentKeys(app: Application, rootKey: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
    if (!app.isBound(key)) return;
    let instance: Component;
    try {
      instance = app.getSync<Component>(key);
    } catch {
      // A component that cannot be resolved synchronously contributes no
      // walkable children; the diff still covers whatever it bound.
      return;
    }
    for (const child of instance.components ?? []) {
      visit(`${CoreBindings.COMPONENTS}.${child.name}`);
    }
  };
  visit(rootKey);
  return keys;
}

/**
 * Import a resolved plugin, mount its `Component` via `app.component()`, and
 * detect DI-key collisions against `ctx`. Returns a `PluginLoadError` (without
 * throwing) on any failure so callers choose their own fail policy; mutates
 * `ctx.owners` for every key this mount touches and bumps `refs` for every
 * component key it references.
 *
 * A REJECTED mount leaves nothing behind: `app.component()` has already run
 * its side effects by the time the collision is known, so the teardown is
 * built from the diff first and run on the error path. Otherwise a rejected
 * plugin stays mounted AND absent from `report.mounted` — a leak invisible in
 * the one artifact this package offers as an audit trail.
 */
export async function tryMount(
  app: Application,
  info: PluginInfo,
  ctx: MountContext,
  refs: Map<string, ComponentEntry>,
): Promise<MountOutcome> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(info.importSpecifier)) as Record<string, unknown>;
  } catch (err) {
    return {
      ok: false,
      error: {package: info.name, kind: 'import', message: String(err)},
    };
  }

  const exported = mod[info.component];
  if (typeof exported !== 'function') {
    return {
      ok: false,
      error: {
        package: info.name,
        kind: 'missing-export',
        message: `named export "${info.component}" is missing or not a class`,
      },
    };
  }

  const before = boundBindings(app);
  let rootKey: string;
  try {
    rootKey = app.component(exported as new (...args: unknown[]) => Component)
      .key;
  } catch (err) {
    return {
      ok: false,
      error: {package: info.name, kind: 'import', message: String(err)},
    };
  }
  const after = boundBindings(app);

  const touched: TouchedBinding[] = [];
  const collisions: string[] = [];
  // Remember each key's owner BEFORE we claim it, so a rejected mount can put
  // the ledger back exactly as it found it.
  const priorOwners = new Map<string, string | undefined>();
  for (const [key, binding] of after) {
    const priorBinding = before.get(key);
    if (priorBinding === binding) continue;
    touched.push({binding, displaced: priorBinding});
    const prior = ctx.owners.get(key);
    priorOwners.set(key, prior);
    if (prior && prior !== info.name && !ctx.allowOverride.has(key)) {
      collisions.push(key);
    }
    ctx.owners.set(key, info.name);
  }
  const componentKeys = referencedComponentKeys(app, rootKey);

  if (collisions.length) {
    // Roll back directly from this mount's own diff — no refcounts involved,
    // because nothing has been recorded or incremented yet. `touched` is
    // exactly what this mount created, so reverting it removes everything and
    // touches nothing another plugin owns.
    for (let i = touched.length - 1; i >= 0; i--) {
      const {binding, displaced} = touched[i];
      revertOwned(app, binding, displaced);
    }
    for (const [key, prior] of priorOwners) {
      if (prior === undefined) ctx.owners.delete(key);
      else ctx.owners.set(key, prior);
    }
    return {
      ok: false,
      error: {
        package: info.name,
        kind: 'key-collision',
        message: `re-binds key(s) owned by another plugin: ${collisions.join(', ')}`,
        collidingKeys: collisions,
      },
    };
  }

  // Attribute each touched binding to the component whose lifetime governs it;
  // whatever belongs to no referenced component is this mount's own.
  const componentKeySet = new Set(componentKeys);
  const ownTouched: TouchedBinding[] = [];
  for (const t of touched) {
    const owner = owningComponent(t.binding, componentKeySet);
    if (owner === undefined) {
      ownTouched.push(t);
      continue;
    }
    const entry = refs.get(owner) ?? {count: 0, touched: []};
    // Recorded by whichever mount actually created them; a later mount that
    // early-returned contributes no bindings and must not clobber the record.
    if (!entry.touched.length) entry.touched.push(t);
    else if (!entry.touched.some(e => e.binding === t.binding)) {
      entry.touched.push(t);
    }
    refs.set(owner, entry);
  }
  for (const key of componentKeys) {
    const entry = refs.get(key) ?? {count: 0, touched: []};
    entry.count += 1;
    refs.set(key, entry);
  }
  return {ok: true, footprint: {ownTouched, componentKeys}};
}

/**
 * The ONE teardown builder — both `loadPlugin` and `loadPlugins` go through
 * it, so the guarded-restore rule lives in exactly one place.
 *
 * Per mount, in reverse mount order:
 *   1. stop retracting lifecycle observers, through the registry, and only
 *      while the app is live
 *   2. `revertOwned` each touched key — ONE identity check gates the unbind
 *      AND the restore
 *   3. a `components.*` key is unbound only once its refcount reaches 0
 */
export function buildTeardown(
  app: Application,
  outcomes: MountOutcome[],
  refs: Map<string, ComponentEntry>,
): () => Promise<void> {
  const teardown = composeTeardown();
  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const {ownTouched, componentKeys} = outcome.footprint;
    teardown.push(async () => {
      // Work out what this teardown will actually revert BEFORE reverting
      // anything: its own bindings, plus the bindings of every referenced
      // component whose refcount this drop takes to zero. A shared component
      // still held by another mount contributes nothing here.
      const toRevert: TouchedBinding[] = [...ownTouched];
      for (const key of componentKeys) {
        const entry = refs.get(key);
        if (!entry) continue;
        entry.count -= 1;
        if (entry.count > 0) continue;
        toRevert.push(...entry.touched);
        refs.delete(key);
      }

      // Observers first — they must still be bound to resolve, and only for
      // bindings this teardown is actually retracting. Gated on app state
      // because Application.stop() itself no-ops outside started|initialized,
      // and a third-party plugin's stop() is not guaranteed idempotent:
      // gating is what prevents a double-stop after app.stop(), rather than
      // trusting someone else's discipline.
      const state = app.state;
      if (state === 'started' || state === 'initialized') {
        const observerKeys = new Set(
          toRevert
            .filter(
              t =>
                t.binding.tagMap[CoreTags.LIFE_CYCLE_OBSERVER] !== undefined &&
                app.isBound(t.binding.key) &&
                app.getBinding(t.binding.key) === t.binding,
            )
            .map(t => t.binding.key),
        );
        if (observerKeys.size) {
          const registry = await app.get<LifeCycleObserverRegistry>(
            CoreBindings.LIFE_CYCLE_OBSERVER_REGISTRY,
          );
          await registry.stopObservers(observerKeys);
        }
      }

      // Reverse order: last binding added is first removed.
      for (let i = toRevert.length - 1; i >= 0; i--) {
        const {binding, displaced} = toRevert[i];
        revertOwned(app, binding, displaced);
      }
    });
  }
  return () => teardown.run();
}
