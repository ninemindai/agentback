// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {loadPlugins} from '../../load-plugins.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../../..'); // packages/plugin

describe('loadPlugins (dir source)', () => {
  it('discovers and mounts a good plugin from a plugins dir', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/good-plugin'],
      },
    });
    expect(report.mounted.map(p => p.name)).toEqual(['@fixture/good-plugin']);
    expect(report.errors).toEqual([]);
  });

  it('strict halt: a broken plugin (missing export) throws and is recorded', async () => {
    const app = new Application();
    await expect(
      loadPlugins(app, {
        cwd: pkgRoot,
        config: {
          scan: false,
          dirs: ['fixtures'],
          enable: ['@fixture/broken-plugin'],
          strict: true,
        },
      }),
    ).rejects.toThrow(/broken-plugin|DoesNotExist/);
  });

  it('non-strict: broken plugin lands in errors, others still mount', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/broken-plugin', '@fixture/good-plugin'],
        strict: false,
      },
    });
    expect(report.errors.map(e => e.kind)).toContain('missing-export');
    expect(report.mounted.map(p => p.name)).toContain('@fixture/good-plugin');
  });

  it('key collision is fatal under strict', async () => {
    const app = new Application();
    await expect(
      loadPlugins(app, {
        cwd: pkgRoot,
        config: {
          scan: false,
          dirs: ['fixtures'],
          enable: ['@fixture/collide-a', '@fixture/collide-b'],
          order: ['@fixture/collide-a', '@fixture/collide-b'],
          strict: true,
        },
      }),
    ).rejects.toThrow(/collision|services\.Shared/);
  });

  it('allowOverride permits an intentional re-bind (last wins)', async () => {
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/collide-a', '@fixture/collide-b'],
        order: ['@fixture/collide-a', '@fixture/collide-b'],
        allowOverride: ['services.Shared'],
        strict: true,
      },
    });
    expect(report.mounted.map(p => p.name)).toEqual([
      '@fixture/collide-a',
      '@fixture/collide-b',
    ]);
    expect(app.getSync('services.Shared')).toBe('b');
  });
});
