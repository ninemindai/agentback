// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * `mountComponent` is the same governed mount as `loadPlugin`, minus the
 * import. These tests exist to prove that "minus the import" is the ONLY
 * difference: a class an agent wrote at runtime gets collision detection,
 * rollback, refcounting and retraction identical to a package on disk.
 */

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {Binding} from '@agentback/context';
import {Application} from '@agentback/core';
import type {Component} from '@agentback/core';
import {loadPlugin} from '../../load-plugin.js';
import {mountComponent} from '../../mount-component.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../..', 'fixtures');

class ScratchComponent implements Component {
  bindings = [Binding.bind('agent.scratch').to('written-at-runtime')];
}

class CollidingComponent implements Component {
  bindings = [Binding.bind('services.Shared').to('from-agent')];
}

describe('mountComponent', () => {
  it('mounts a class with no specifier and retracts it', async () => {
    const app = new Application();
    const handle = await mountComponent(app, ScratchComponent, {
      name: 'agent:scratch-1',
    });
    expect(app.getSync('agent.scratch')).toBe('written-at-runtime');

    await handle.uninstall();
    expect(app.isBound('agent.scratch')).toBe(false);
    expect(app.isBound('components.ScratchComponent')).toBe(false);
  });

  it('is idempotent, like every other Installed', async () => {
    const app = new Application();
    const handle = await mountComponent(app, ScratchComponent, {
      name: 'agent:scratch-1',
    });
    await handle.uninstall();
    await expect(handle.uninstall()).resolves.toBeUndefined();
  });

  it('collides with a disk plugin and rolls back, leaving nothing', async () => {
    const app = new Application();
    // collide-a binds services.Shared from disk.
    await loadPlugin(app, resolve(fixtures, 'collide-a'));
    expect(app.getSync('services.Shared')).toBe('a');

    await expect(
      mountComponent(app, CollidingComponent, {name: 'agent:collider'}),
    ).rejects.toThrow(/key-collision/);

    // The disk plugin is untouched and the rejected mount left nothing.
    expect(app.getSync('services.Shared')).toBe('a');
    expect(app.isBound('components.CollidingComponent')).toBe(false);
  });

  it('honors allowOverride, and restores what it displaced', async () => {
    const app = new Application();
    const original = app.bind('services.Shared').to('app-owned');

    const handle = await mountComponent(app, CollidingComponent, {
      name: 'agent:collider',
      allowOverride: ['services.Shared'],
    });
    expect(app.getSync('services.Shared')).toBe('from-agent');

    await handle.uninstall();
    expect(app.getBinding('services.Shared')).toBe(original);
  });

  it('shares component refcounts with disk plugins', async () => {
    // shared-a lists SharedComponent. An agent-authored component that lists
    // the same one must keep it alive after shared-a retracts.
    const {SharedComponent} = (await import(
      resolve(fixtures, 'shared-component/index.js')
    )) as {SharedComponent: new () => Component};

    class AgentSharesIt implements Component {
      components = [SharedComponent];
    }

    const app = new Application();
    const disk = await loadPlugin(app, resolve(fixtures, 'shared-a'));
    const agent = await mountComponent(app, AgentSharesIt, {
      name: 'agent:shares',
    });
    expect(app.isBound('services.SharedDep')).toBe(true);

    await disk.uninstall();
    expect(app.isBound('services.SharedDep')).toBe(true);

    await agent.uninstall();
    expect(app.isBound('services.SharedDep')).toBe(false);
  });
});
