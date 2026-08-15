// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {Binding} from '@agentback/context';
import {Application} from '@agentback/core';
import type {Component} from '@agentback/core';
import {PluginBindings} from '../../config.js';
import {loadPlugin} from '../../load-plugin.js';
import {loadPlugins} from '../../load-plugins.js';
import {mountComponent} from '../../mount-component.js';
import type {PluginRegistry} from '../../registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../../..');
const fixtures = resolve(pkgRoot, 'fixtures');

const reg = (app: Application) =>
  app.getSync<PluginRegistry>(PluginBindings.REGISTRY);

class ScratchComponent implements Component {
  bindings = [Binding.bind('agent.scratch').to('x')];
}

describe('plugin registry', () => {
  it('reports what is mounted, from every source', async () => {
    const app = new Application();
    await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/good-plugin'],
      },
    });
    await mountComponent(app, ScratchComponent, {name: 'agent:scratch'});

    const mounted = reg(app).mounted();
    expect(mounted.map(p => p.name).sort()).toEqual([
      '@fixture/good-plugin',
      'agent:scratch',
    ]);
    expect(mounted.find(p => p.name === 'agent:scratch')?.source).toBe(
      'memory',
    );
    expect(mounted.find(p => p.name === '@fixture/good-plugin')?.source).toBe(
      'dir',
    );
  });

  it('drops an entry when the plugin is retracted', async () => {
    const app = new Application();
    const handle = await mountComponent(app, ScratchComponent, {
      name: 'agent:scratch',
    });
    expect(reg(app).mounted()).toHaveLength(1);

    await handle.uninstall();
    expect(reg(app).mounted()).toEqual([]);
  });

  it('exposes component refcounts', async () => {
    const app = new Application();
    const a = await loadPlugin(app, resolve(fixtures, 'shared-a'));
    await loadPlugin(app, resolve(fixtures, 'shared-b'));

    expect(reg(app).componentRefs().get('components.SharedComponent')).toBe(2);
    await a.uninstall();
    expect(reg(app).componentRefs().get('components.SharedComponent')).toBe(1);
  });

  it('uninstalling the FIRST plugin does not unbind the registry', async () => {
    // The registry has to be bound outside any mount window. If it lands in
    // the first mount's binding diff it becomes part of that plugin's
    // footprint, and retracting that plugin takes the registry out from
    // under everything else.
    const app = new Application();
    const first = await loadPlugin(app, resolve(fixtures, 'good-plugin'));
    await mountComponent(app, ScratchComponent, {name: 'agent:scratch'});

    await first.uninstall();

    expect(app.isBound(PluginBindings.REGISTRY.key)).toBe(true);
    expect(
      reg(app)
        .mounted()
        .map(p => p.name),
    ).toEqual(['agent:scratch']);
  });
});
