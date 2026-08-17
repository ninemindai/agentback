// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * End-to-end proof of the runtime-mount chain: mounting a Component that
 * contributes a REST controller into an ALREADY-RUNNING app makes the route
 * serve, and retracting it takes the route away again.
 *
 * `mountComponent` shares `mountResolved` with the disk-plugin path, so this
 * covers the same code `loadPlugin`/`loadPlugins` run — without needing a
 * fixture that could not carry compiled decorators anyway.
 */

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import type {Component, LifeCycleObserver} from '@agentback/core';
import {Binding} from '@agentback/context';
import {RestApplication} from '@agentback/rest';
import {mountComponent} from '../../mount-component.js';

@api({basePath: '/plugged'})
class PluggedController {
  @get('/hello', {response: z.object({from: z.string()})})
  hello() {
    return {from: 'plugin'};
  }
}

class ControllerComponent implements Component {
  controllers = [PluggedController];
}

class AlphaComponent implements Component {
  bindings = [Binding.bind('services.Alpha').to('a')];
}

class BetaComponent implements Component {
  bindings = [Binding.bind('services.Beta').to('b')];
}

const sharedStarts: string[] = [];

class SharedObserver implements LifeCycleObserver {
  async start() {
    sharedStarts.push('shared');
  }
}

class SharedComponent implements Component {
  bindings = [Binding.bind('services.Shared').to('shared')];
  lifeCycleObservers = [SharedObserver];
}

class HostAComponent implements Component {
  components = [SharedComponent];
}

class HostBComponent implements Component {
  components = [SharedComponent];
}

describe('runtime mount — derived surfaces', () => {
  let app: RestApplication;

  afterEach(async () => app.stop());

  it('a controller mounted into a RUNNING app is served, then retracted', async () => {
    app = new RestApplication({rest: {port: 0, host: '127.0.0.1'}});
    await app.start();
    const server = await app.restServer;
    const hello = async () => fetch(`${server.url}/plugged/hello`);

    expect((await hello()).status).toBe(404);

    const installed = await mountComponent(app, ControllerComponent, {
      name: 'controller-plugin',
    });
    // No explicit refresh by the caller: the mount re-derives the surface
    // because the app is already started.
    const served = await hello();
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({from: 'plugin'});

    await installed.uninstall();
    // Retraction was already live via the per-request controller gate; the two
    // halves have to compose.
    expect((await hello()).status).toBe(404);
  });

  it('does NOT refresh when the app has not started', async () => {
    // Before start() the normal collection pass has yet to run, so a refresh
    // would be wasted work — and worse, would build the fetch memo early.
    app = new RestApplication({rest: {port: 0, host: '127.0.0.1'}});
    const installed = await mountComponent(app, ControllerComponent, {
      name: 'controller-plugin',
    });

    await app.start();
    const server = await app.restServer;
    // start()'s own pass picks it up, so the route serves regardless.
    const res = await fetch(`${server.url}/plugged/hello`);
    expect(res.status).toBe(200);
    await installed.uninstall();
  });

  it('a plugin can be re-mounted after uninstall and serves again', async () => {
    // `controller()` early-returns for a class it has already mounted, and
    // Express cannot unmount, so the second mount adds NO new layer. It must
    // still serve: the original layer re-admits through the per-request
    // liveness gate once the controller binding is back.
    app = new RestApplication({rest: {port: 0, host: '127.0.0.1'}});
    await app.start();
    const server = await app.restServer;
    const hello = async () => fetch(`${server.url}/plugged/hello`);

    const first = await mountComponent(app, ControllerComponent, {
      name: 'controller-plugin',
    });
    expect((await hello()).status).toBe(200);
    await first.uninstall();
    expect((await hello()).status).toBe(404);

    const second = await mountComponent(app, ControllerComponent, {
      name: 'controller-plugin',
    });
    expect((await hello()).status).toBe(200);
    await second.uninstall();
    expect((await hello()).status).toBe(404);
  });

  it('concurrent mounts each retract cleanly and independently', async () => {
    // PROPERTY, not a regression: this passes with the mount lock removed. The
    // review claimed the new awaits opened a corrupting interleave; tracing it
    // afterwards, they do not — `touched` and the owners ledger are both
    // written synchronously BEFORE any await, and only the component refcount
    // increments land after, which interleave correctly in either order. The
    // lock is kept as a forward guard (any await a later edit adds inside that
    // section is then safe by construction), not because this test failed
    // without it. Do not cite it as proof the lock is load-bearing.
    app = new RestApplication({rest: {port: 0, host: '127.0.0.1'}});
    await app.start();

    const [a, b] = await Promise.all([
      mountComponent(app, AlphaComponent, {name: 'alpha'}),
      mountComponent(app, BetaComponent, {name: 'beta'}),
    ]);

    expect(app.isBound('services.Alpha')).toBe(true);
    expect(app.isBound('services.Beta')).toBe(true);

    await a.uninstall();
    // Retracting one must not disturb the other, and must fully retract itself.
    expect(app.isBound('services.Alpha')).toBe(false);
    expect(app.isBound('services.Beta')).toBe(true);

    await b.uninstall();
    expect(app.isBound('services.Beta')).toBe(false);
    expect(app.isBound('components.AlphaComponent')).toBe(false);
    expect(app.isBound('components.BetaComponent')).toBe(false);
  });

  it('does not double-start a shared nested component on a running app', async () => {
    // Mounting a second plugin that lists the same nested Component adds NO new
    // bindings (app.component() early-returns), so the shared component's
    // already-running observers must be left alone rather than started twice.
    sharedStarts.length = 0;
    app = new RestApplication({rest: {port: 0, host: '127.0.0.1'}});
    await app.start();

    const first = await mountComponent(app, HostAComponent, {name: 'host-a'});
    expect(sharedStarts).toEqual(['shared']);

    const second = await mountComponent(app, HostBComponent, {name: 'host-b'});
    expect(sharedStarts).toEqual(['shared']);

    // Refcounted: the shared component survives the first uninstall.
    await first.uninstall();
    expect(app.isBound('services.Shared')).toBe(true);
    await second.uninstall();
    expect(app.isBound('services.Shared')).toBe(false);
  });
});
