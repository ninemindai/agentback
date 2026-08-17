// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Application} from '../../application.js';
import {CoreTags} from '../../keys.js';
import {refreshSurfaces} from '../../refreshable-surface.js';
import type {RefreshableSurface} from '../../refreshable-surface.js';
import type {Server} from '../../server.js';

const calls: string[] = [];

class RefreshableServer implements Server, RefreshableSurface {
  listening = false;
  async start() {
    this.listening = true;
  }
  async stop() {
    this.listening = false;
  }
  refreshSurface() {
    calls.push('refreshable');
  }
}

class PlainServer implements Server {
  listening = false;
  async start() {
    this.listening = true;
  }
  async stop() {
    this.listening = false;
  }
}

class ThrowingServer implements Server, RefreshableSurface {
  listening = false;
  async start() {
    this.listening = true;
  }
  async stop() {
    this.listening = false;
  }
  refreshSurface(): void {
    calls.push('throwing');
    throw new Error('refresh exploded');
  }
}

describe('refreshSurfaces', () => {
  it('refreshes servers implementing the interface and skips the rest', async () => {
    calls.length = 0;
    const app = new Application();
    app.server(RefreshableServer);
    app.server(PlainServer);
    await app.start();

    await refreshSurfaces(app);

    expect(calls).toEqual(['refreshable']);
    expect(await refreshSurfaces(app)).toEqual([]);
    await app.stop();
  });

  it('does not resolve a server that was never started', async () => {
    // Resolving here would CONSTRUCT a server as a side effect of a refresh —
    // a much larger action than the caller asked for, and pointless besides
    // since nothing is serving yet.
    calls.length = 0;
    const app = new Application();
    app.server(RefreshableServer);

    await refreshSurfaces(app);

    expect(calls).toEqual([]);
  });

  it('RETURNS a throwing server as a failure instead of swallowing it', async () => {
    // Swallowing was indistinguishable from success: loggers() is
    // debug-namespaced, so the caller went on to report a mount that serves
    // nothing. The caller decides what a failure means; this only reports it.
    calls.length = 0;
    const app = new Application();
    app.server(ThrowingServer);
    app.server(RefreshableServer);
    await app.start();

    const failures = await refreshSurfaces(app);

    expect(failures).toHaveLength(1);
    expect(failures[0].key).toBe('servers.ThrowingServer');
    expect((failures[0].error as Error).message).toBe('refresh exploded');
    // A failure must not stop the loop — the healthy server still refreshed.
    expect(calls).toEqual(['throwing', 'refreshable']);
    await app.stop();
  });

  it('reports an async-resolved server rather than skipping it silently', async () => {
    // getSync throws for a binding that resolves asynchronously. Skipping it
    // quietly would mean promising a surface is current when we never reached
    // the server that serves it.
    calls.length = 0;
    const app = new Application();
    await app.start();
    // Bound AFTER start, which is the only way this is reachable: app.start()
    // resolves every server it can see, so anything present at boot is cached
    // and getSync hits. A server contributed by a runtime plugin mount is not.
    app
      .bind('servers.AsyncServer')
      .toDynamicValue(async () => new RefreshableServer())
      .tag(CoreTags.SERVER);

    const failures = await refreshSurfaces(app);

    expect(failures).toHaveLength(1);
    expect(failures[0].key).toBe('servers.AsyncServer');
    expect(calls).toEqual([]);
    await app.stop();
  });
});
