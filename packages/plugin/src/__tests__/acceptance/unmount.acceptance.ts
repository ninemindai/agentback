// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {loadPlugin} from '../../load-plugin.js';
import {loadPlugins} from '../../load-plugins.js';
import type {PluginLoadReport} from '../../types.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../../..'); // packages/plugin
const fixtures = resolve(pkgRoot, 'fixtures');

describe('uninstall — bindings', () => {
  it('retracts a mounted plugin and is idempotent', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/good-plugin'],
      },
    });
    expect(app.isBound('components.GoodComponent')).toBe(true);

    await report.uninstall();
    expect(app.isBound('components.GoodComponent')).toBe(false);
    await expect(report.uninstall()).resolves.toBeUndefined();
  });

  it('restores a displaced binding by INSTANCE identity', async () => {
    const app = new Application();
    const original = app.bind('services.Shared').to('app-owned');

    const installed = await loadPlugin(app, resolve(fixtures, 'collide-a'), {
      allowOverride: ['services.Shared'],
    });
    expect(app.getSync('services.Shared')).toBe('a');

    await installed.uninstall();
    expect(app.getBinding('services.Shared')).toBe(original);
    expect(app.getSync('services.Shared')).toBe('app-owned');
  });

  it('touches NOTHING when a third party rebound a touched key', async () => {
    const app = new Application();
    app.bind('services.Shared').to('app-owned');
    const installed = await loadPlugin(app, resolve(fixtures, 'collide-a'), {
      allowOverride: ['services.Shared'],
    });

    // Somebody else shadows the key AFTER the plugin mounted.
    const third = app.bind('services.Shared').to('third-party');
    await installed.uninstall();

    // Neither the unbind nor the restore may fire — an unguarded restore is
    // as destructive as an unguarded unbind.
    expect(app.getBinding('services.Shared')).toBe(third);
    expect(app.getSync('services.Shared')).toBe('third-party');
  });

  it('loadPlugin round-trips: mount -> uninstall -> re-mount', async () => {
    const app = new Application();
    const installed = await loadPlugin(app, resolve(fixtures, 'good-plugin'));
    expect(app.isBound('components.GoodComponent')).toBe(true);

    await installed.uninstall();
    expect(app.isBound('components.GoodComponent')).toBe(false);

    // Re-mount must WORK. app.component() early-returns when the component
    // binding is still present, so a footprint that missed components.* would
    // make this a silent no-op that still reported as mounted.
    const again = await loadPlugin(app, resolve(fixtures, 'good-plugin'));
    expect(again.name).toBe('@fixture/good-plugin');
    expect(app.isBound('components.GoodComponent')).toBe(true);
  });
});

describe('uninstall — collision rollback', () => {
  it('a rejected mount leaves NOTHING bound', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/collide-a', '@fixture/collide-b'],
        order: ['@fixture/collide-a', '@fixture/collide-b'],
        strict: false,
      },
    });

    expect(report.errors.map(e => e.kind)).toEqual(['key-collision']);
    expect(report.mounted.map(p => p.name)).toEqual(['@fixture/collide-a']);
    // The rejected plugin mounted before the collision was known; it must not
    // still be bound, or it is a leak invisible in report.mounted.
    expect(app.isBound('components.CollideBComponent')).toBe(false);
    // …and the winner is untouched.
    expect(app.getSync('services.Shared')).toBe('a');
  });
});

describe('uninstall — lifecycle observers', () => {
  it('does NOT stop an observer when the app was never started', async () => {
    const app = new Application();
    const installed = await loadPlugin(
      app,
      resolve(fixtures, 'observer-plugin'),
    );
    const stops = app.getSync<string[]>('test.observerStops');
    stops.length = 0;

    await installed.uninstall();
    expect(stops).toEqual([]);
  });

  it('stops the observer when the app IS started', async () => {
    const app = new Application();
    const installed = await loadPlugin(
      app,
      resolve(fixtures, 'observer-plugin'),
    );
    const stops = app.getSync<string[]>('test.observerStops');
    stops.length = 0;

    await app.start();
    await installed.uninstall();
    expect(stops).toEqual(['observer-plugin']);
    await app.stop();
  });

  it('app.stop() then uninstall() does not double-stop', async () => {
    const app = new Application();
    const installed = await loadPlugin(
      app,
      resolve(fixtures, 'observer-plugin'),
    );
    const stops = app.getSync<string[]>('test.observerStops');
    stops.length = 0;

    await app.start();
    await app.stop();
    await installed.uninstall();
    expect(stops).toEqual(['observer-plugin']);
  });
});

describe('uninstall — shared nested components', () => {
  it('uninstalling one plugin leaves the other working', async () => {
    const app = new Application();
    const a = await loadPlugin(app, resolve(fixtures, 'shared-a'));
    const b = await loadPlugin(app, resolve(fixtures, 'shared-b'));
    expect(app.isBound('services.SharedDep')).toBe(true);

    await a.uninstall();

    // B still lists SharedComponent. app.component() early-returned for B, so
    // B's binding diff never saw these keys — only the refcount protects them.
    expect(app.isBound('components.SharedComponent')).toBe(true);
    expect(app.isBound('services.SharedDep')).toBe(true);
    expect(app.isBound('components.SharedAComponent')).toBe(false);

    await b.uninstall();
    expect(app.isBound('components.SharedComponent')).toBe(false);
    expect(app.isBound('components.SharedBComponent')).toBe(false);
  });

  it('a repeated uninstall does not retract what another plugin still holds', async () => {
    // Idempotency has to be asserted against SHARED state. A single-plugin
    // "second call resolves" test passes even when the second call re-runs
    // every disposer, because the identity guard makes re-reverting an
    // already-unbound key a silent no-op — there is nothing left to corrupt.
    // With two plugins there is: a double decrement drops the shared
    // component's refcount to zero and unbinds it under the other plugin.
    const app = new Application();
    const a = await loadPlugin(app, resolve(fixtures, 'shared-a'));
    await loadPlugin(app, resolve(fixtures, 'shared-b'));

    await a.uninstall();
    await a.uninstall();
    await a.uninstall();

    expect(app.isBound('components.SharedComponent')).toBe(true);
    expect(app.isBound('services.SharedDep')).toBe(true);
  });
});

describe('uninstall — strict partial load', () => {
  it('a strict failure mid-load still retracts what DID mount', async () => {
    const app = new Application();
    let thrown: (Error & {report?: PluginLoadReport}) | undefined;
    try {
      await loadPlugins(app, {
        cwd: pkgRoot,
        config: {
          scan: false,
          dirs: ['fixtures'],
          enable: ['@fixture/good-plugin', '@fixture/broken-plugin'],
          order: ['@fixture/good-plugin', '@fixture/broken-plugin'],
        },
      });
    } catch (err) {
      thrown = err as Error & {report?: PluginLoadReport};
    }
    expect(thrown).toBeDefined();
    expect(app.isBound('components.GoodComponent')).toBe(true);

    await thrown!.report!.uninstall();
    expect(app.isBound('components.GoodComponent')).toBe(false);
  });
});

describe('uninstall — repeated mounts are refcounted', () => {
  it('two mounts of one plugin need two uninstalls', async () => {
    // app.component() early-returns for a component already bound to the same
    // class, so the second mount binds nothing and simply takes a reference.
    const app = new Application();
    const one = await loadPlugin(app, resolve(fixtures, 'good-plugin'));
    const two = await loadPlugin(app, resolve(fixtures, 'good-plugin'));

    await one.uninstall();
    expect(app.isBound('components.GoodComponent')).toBe(true);

    await two.uninstall();
    expect(app.isBound('components.GoodComponent')).toBe(false);
  });
});

describe('uninstall — a failing observer must not strand bindings', () => {
  it('reverts everything even when stop() rejects, and still reports', async () => {
    // The refcounts are decremented BEFORE observers run, so an early exit on
    // a failing stop() would leave the bindings mounted with no record of who
    // owns them — unrecoverable, and worse than the original failure.
    const app = new Application();
    const installed = await loadPlugin(
      app,
      resolve(fixtures, 'bad-observer-plugin'),
    );
    await app.start();
    expect(app.isBound('plugin.badObserverMarker')).toBe(true);

    // composeTeardown aggregates disposer failures into one AggregateError.
    const err = await installed.uninstall().then(
      () => undefined,
      (e: unknown) => e as AggregateError,
    );
    expect(err).toBeInstanceOf(AggregateError);
    expect(String(err!.errors[0])).toMatch(/exploded/);

    // The failure is surfaced, AND the retraction completed.
    expect(app.isBound('plugin.badObserverMarker')).toBe(false);
    expect(app.isBound('components.BadObserverComponent')).toBe(false);
    await app.stop();
  });
});

describe('uninstall — report.uninstall() idempotency, against shared state', () => {
  it('a repeated report.uninstall() does not retract what another holder keeps', async () => {
    // The loadPlugin path had this test; the loadPlugins path did not, and the
    // single-plugin "second call resolves" test above cannot see the failure
    // because there is nothing shared left to corrupt. Memoizing a BUILDER
    // instead of the promise passes that test and fails this one.
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {scan: false, dirs: ['fixtures'], enable: ['@fixture/shared-a']},
    });
    const other = await loadPlugin(app, resolve(fixtures, 'shared-b'));
    expect(app.isBound('services.SharedDep')).toBe(true);

    await report.uninstall();
    await report.uninstall();
    await report.uninstall();

    expect(app.isBound('services.SharedDep')).toBe(true);
    expect(app.isBound('components.SharedComponent')).toBe(true);

    await other.uninstall();
    expect(app.isBound('components.SharedComponent')).toBe(false);
  });
});
