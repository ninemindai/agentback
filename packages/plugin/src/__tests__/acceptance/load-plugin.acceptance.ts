// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {loadPlugin} from '../../load-plugin.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../../..'); // packages/plugin
const fixtures = resolve(pkgRoot, 'fixtures');

describe('loadPlugin (imperative, single specifier)', () => {
  it('mounts a marked plugin from a local dir path', async () => {
    const app = new Application();
    const info = await loadPlugin(app, resolve(fixtures, 'good-plugin'));
    expect(info.name).toBe('@fixture/good-plugin');
    expect(info.component).toBe('GoodComponent');
    expect(app.isBound('components.GoodComponent')).toBe(true);
  });

  it('mounts a marked plugin from a file: URL', async () => {
    const app = new Application();
    const url = pathToFileURL(resolve(fixtures, 'good-plugin')).href;
    const info = await loadPlugin(app, url);
    expect(info.name).toBe('@fixture/good-plugin');
    expect(app.isBound('components.GoodComponent')).toBe(true);
  });

  it('mounts an UNMARKED package when given an explicit component', async () => {
    const app = new Application();
    const info = await loadPlugin(app, resolve(fixtures, 'unmarked'), {
      component: 'UnmarkedComponent',
    });
    expect(info.name).toBe('@fixture/unmarked');
    expect(info.component).toBe('UnmarkedComponent');
    expect(app.isBound('components.UnmarkedComponent')).toBe(true);
  });

  it('rejects an unmarked package with no explicit component', async () => {
    const app = new Application();
    await expect(
      loadPlugin(app, resolve(fixtures, 'unmarked')),
    ).rejects.toThrow(/marker|component/i);
  });

  it('rejects when a marked plugin is missing its named export', async () => {
    const app = new Application();
    await expect(
      loadPlugin(app, resolve(fixtures, 'broken-plugin')),
    ).rejects.toThrow(/missing-export|missing or not a class/i);
  });

  it('rejects an unresolvable bare specifier', async () => {
    const app = new Application();
    await expect(
      loadPlugin(app, '@fixture/does-not-exist-anywhere'),
    ).rejects.toThrow(/resolve|import/i);
  });

  it('throws on a collision with an app-owned binding', async () => {
    const app = new Application();
    await loadPlugin(app, resolve(fixtures, 'collide-a'));
    await expect(
      loadPlugin(app, resolve(fixtures, 'collide-b')),
    ).rejects.toThrow(/collision|services\.Shared/);
  });

  it('allowOverride permits an intentional re-bind of an existing key', async () => {
    const app = new Application();
    await loadPlugin(app, resolve(fixtures, 'collide-a'));
    const info = await loadPlugin(app, resolve(fixtures, 'collide-b'), {
      allowOverride: ['services.Shared'],
    });
    expect(info.name).toBe('@fixture/collide-b');
    expect(app.getSync('services.Shared')).toBe('b');
  });
});
