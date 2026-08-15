// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Application, Component, Installed} from '@agentback/core';
import {
  appOwnedContext,
  buildTeardown,
  componentRefsFor,
  mountResolved,
} from './mount.js';
import {pluginRegistryFor} from './registry.js';

export interface MountComponentOptions {
  /**
   * Identity in the owners ledger and the registry. Required rather than
   * derived from the class, because two components authored in different
   * turns can share a class name and the ledger keys on this.
   */
  name: string;
  /** DI keys this mount may intentionally re-bind (else a re-bind throws). */
  allowOverride?: string[];
}

/**
 * Mount a `Component` **class** with the same governance `loadPlugin` applies
 * to a package, and return its inverse.
 *
 * `loadPlugin` resolves a specifier against disk or the npm graph, which
 * assumes a human with a filesystem. A component written at runtime has no
 * specifier. `Application.component()` would take the class but skips every
 * guarantee the loader exists for: no collision detection against other
 * plugins, no `Installed` handle, no participation in the component refcount.
 *
 * This is the middle: the class goes straight into `mountResolved`, which is
 * the half of `tryMount` that runs *after* the import, so collision
 * detection, rollback on rejection, refcounting and retraction are the same
 * code paths a disk plugin takes.
 *
 * Mounting is a write, so this does NOT belong on a read-only introspection
 * surface. Whatever exposes it as an agent-callable tool owns the trust gate.
 *
 * @throws when the mount collides with a key another plugin owns (the mount is
 * rolled back first, leaving nothing behind).
 */
export async function mountComponent(
  app: Application,
  ctor: new (...args: unknown[]) => Component,
  options: MountComponentOptions,
): Promise<Installed> {
  const refs = componentRefsFor(app);
  // Before appOwnedContext snapshots, so the registry binding is already
  // app-owned and can never land in this mount's footprint.
  const registry = pluginRegistryFor(app, refs);
  const ctx = appOwnedContext(app, options.allowOverride ?? []);
  const outcome = await mountResolved(app, options.name, ctor, ctx, refs);
  if (!outcome.ok) {
    const {error} = outcome;
    const e = new Error(
      `[plugin:${error.package}] ${error.kind}: ${error.message}`,
    ) as Error & {error?: typeof error};
    e.error = error;
    throw e;
  }
  // Memoized for the same reason every other handle memoizes: composeTeardown
  // is idempotent per instance, so rebuilding would decrement a shared
  // component's refcount twice.
  registry.add({
    name: options.name,
    version: '0.0.0',
    component: ctor.name,
    source: 'memory',
    provides: [],
    inject: [],
  });
  const inverse = buildTeardown(app, [outcome], refs);
  let teardownRun: Promise<void> | undefined;
  return {
    uninstall: () =>
      (teardownRun ??= inverse().finally(() => registry.remove(options.name))),
  };
}
