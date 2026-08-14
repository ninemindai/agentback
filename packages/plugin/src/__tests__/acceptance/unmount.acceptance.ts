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
