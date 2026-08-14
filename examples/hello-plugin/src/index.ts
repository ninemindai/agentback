// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Hello, Plugin — the two ways AgentBack mounts Component-contributing plugins:
//   1. loadPlugins(app, {dirs}) — DECLARATIVE: discover every *marked* package
//      under a directory, gate, and mount with fail-closed DI-key governance.
//   2. loadPlugin(app, specifier) — IMPERATIVE: mount one plugin by path/name,
//      even an UNMARKED one, by naming its component export.
// Both contribute DI bindings that the host's REST controller injects.

import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {inject, isMain} from '@agentback/core';
import {RestApplication} from '@agentback/rest';
import {loadPlugin, loadPlugins} from '@agentback/plugin';

const Info = z.object({greeting: z.string(), stamp: z.string()});

@api({})
class InfoController {
  // These bindings don't exist in this file — plugins contribute them.
  constructor(
    @inject('plugin.greeting') private greeting: string,
    @inject('plugin.stamp') private stamp: string,
  ) {}

  @get('/info', {response: Info})
  async info(): Promise<z.infer<typeof Info>> {
    return {greeting: this.greeting, stamp: this.stamp};
  }
}

async function main() {
  const app = new RestApplication({});

  // Resolve plugins relative to the package root, not the launch cwd, so the
  // example runs from anywhere.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  // 1. Declarative discovery. `scan: false` skips the npm-dependency source;
  // we only scan ./plugins. The marked greeting-plugin is found; the unmarked
  // stamp-plugin is silently ignored (no `agentback` marker).
  const report = await loadPlugins(app, {
    cwd: root,
    config: {scan: false, dirs: ['plugins']},
  });
  console.log(
    'loadPlugins → discovered:',
    report.discovered.map(p => p.name),
  );
  console.log(
    'loadPlugins → mounted:   ',
    report.mounted.map(p => p.name),
  );

  // 2. Imperative mount of the UNMARKED stamp-plugin. It need not be a declared
  // dependency and carries no marker, so we name the export with {component}.
  const stamp = await loadPlugin(app, './plugins/stamp-plugin', {
    cwd: root,
    component: 'StampPlugin',
  });
  console.log('loadPlugin  → mounted:   ', [stamp.name]);

  // The same fail-closed governance applies to both: a plugin re-binding a key
  // the app (or an earlier plugin) already owns throws unless you pass it in
  // `allowOverride`. Here the two plugins bind disjoint keys, so all is well.

  // 3. Mount order is DERIVED, not hand-maintained. banner-plugin declares
  // `inject: ["plugin.greeting"]` and greeting-plugin declares the matching
  // `provides`, so the provider mounts first even though directory scanning
  // discovers "banner-plugin" earlier (alphabetically). With no declarations
  // at all there are no edges, and the manifest's `order:` governs as before.
  console.log(
    '\nmount order (topological, not discovery order):',
    report.mounted.map(p => p.name).join(' → '),
  );

  app.restController(InfoController);
  await app.start();

  const server = await app.restServer;
  console.log(`\nhello-plugin listening at ${server.url}`);
  console.log(`    GET ${server.url}/info`);
}

/**
 * 4. Retraction. Both entry points return their inverse, so a mounted plugin
 * set is a value you can hand back rather than a one-way side effect.
 *
 * Runs against its own throwaway app so the served example above stays up —
 * uninstalling the plugins the live controller injects would break `/info`,
 * which is exactly the point: `uninstall()` really does remove them.
 */
async function retractionDemo(root: string) {
  const app = new RestApplication({});
  const report = await loadPlugins(app, {
    cwd: root,
    config: {scan: false, dirs: ['plugins']},
  });
  const one = await loadPlugin(app, './plugins/stamp-plugin', {
    cwd: root,
    component: 'StampPlugin',
  });

  console.log('\n--- retraction ---');
  console.log(
    'bound before:',
    app.isBound('plugin.greeting'),
    app.isBound('plugin.stamp'),
  );

  await one.uninstall(); // loadPlugin -> PluginInfo & Installed
  await report.uninstall(); // loadPlugins -> report satisfies Installed

  console.log(
    'bound after: ',
    app.isBound('plugin.greeting'),
    app.isBound('plugin.stamp'),
  );
  // Idempotent: a second call is a no-op, never an error.
  await report.uninstall();
}

if (isMain(import.meta)) {
  try {
    await main();
    await retractionDemo(
      resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    );
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
