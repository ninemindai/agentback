// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * A provider must outlive its consumers. Retracting it while something still
 * injects what it provides leaves that consumer resolving a key nothing
 * supplies, and a consumer's own teardown often needs the very dependency it
 * is losing (closing a pool means handing connections back to whatever
 * provided them).
 *
 * LIFO composition gives this ordering inside one report, because the graph
 * mounts providers first and the inverse replays in reverse. It gives nothing
 * across independent handles, which is what these tests cover.
 */

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {loadPlugin} from '../../load-plugin.js';
import {loadPlugins} from '../../load-plugins.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../../..');
const fixtures = resolve(pkgRoot, 'fixtures');

// graph-provider declares provides: ["services.Shared"].
// graph-consumer declares inject:  ["services.Shared"].
const provider = () => resolve(fixtures, 'graph-provider');
const consumer = () => resolve(fixtures, 'graph-consumer');

describe('retraction ordering', () => {
  it('refuses to retract a provider a live consumer still injects', async () => {
    const app = new Application();
    const p = await loadPlugin(app, provider());
    await loadPlugin(app, consumer());

    await expect(p.uninstall()).rejects.toThrow(
      /@fixture\/graph-consumer.*services\.Shared|services\.Shared.*@fixture\/graph-consumer/s,
    );

    // Fail closed means nothing moved.
    expect(app.isBound('services.Shared')).toBe(true);
    expect(app.isBound('components.ProviderComponent')).toBe(true);
  });

  it('allows it once the consumer is gone', async () => {
    const app = new Application();
    const p = await loadPlugin(app, provider());
    const c = await loadPlugin(app, consumer());

    await c.uninstall();
    await expect(p.uninstall()).resolves.toBeUndefined();
    expect(app.isBound('services.Shared')).toBe(false);
  });

  it('allows retracting both together through one report', async () => {
    // The report owns both, so nothing is left behind to be broken.
    const app = new Application();
    const report = await loadPlugins(app, {
      cwd: pkgRoot,
      config: {
        scan: false,
        dirs: ['fixtures'],
        enable: ['@fixture/graph-provider', '@fixture/graph-consumer'],
      },
    });
    expect(report.mounted).toHaveLength(2);

    await expect(report.uninstall()).resolves.toBeUndefined();
    expect(app.isBound('services.Shared')).toBe(false);
  });

  it('does not catch an UNDER-declared inject', async () => {
    // Declarations are advisory everywhere else in this package, and the
    // guard reads the same declarations. A consumer that never declared its
    // inject is invisible to it, which is a documented limit rather than a
    // bug: the alternative is resolving the container at teardown time.
    const app = new Application();
    const p = await loadPlugin(app, provider());
    await loadPlugin(app, resolve(fixtures, 'good-plugin')); // declares nothing

    await expect(p.uninstall()).resolves.toBeUndefined();
  });
});
