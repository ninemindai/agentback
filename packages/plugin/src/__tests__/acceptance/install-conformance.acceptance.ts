// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * A plugin that contributes a controller runs through the SAME conformance
 * suite every `install*` helper runs — install → serve → uninstall → 404 →
 * reinstall → serve, on both the Express and fetch hosts.
 *
 * Reusing that suite rather than writing a plugin-specific one is deliberate:
 * `loadPlugin` returns an `Installed`, so it IS an install helper as far as
 * the revertible-install contract is concerned, and the contract should be
 * proven by the same test for every implementor of it.
 */

import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {RestApplication} from '@agentback/rest';
import {runInstallConformance} from '@agentback/testing';
import {loadPlugin} from '../../load-plugin.js';

const here = dirname(fileURLToPath(import.meta.url));
// dist/__tests__/acceptance -> dist/__tests__/fixtures
const routePlugin = resolve(here, '../fixtures/route-plugin.js');

runInstallConformance('loadPlugin (controller-contributing plugin)', {
  makeApp: () => new RestApplication({rest: {port: 0}}),
  install: app => loadPlugin(app, routePlugin, {component: 'RouteComponent'}),
  served: ['/plugin-ping'],
});
