// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Shared conformance suite for the revertible-install contract
 * (docs/proposals/revertible-installs.md): every migrated `install*` helper
 * runs the same install → serve → uninstall → 404 cycle on BOTH hosts, so
 * the contract cannot decay helper-by-helper. Mirror of
 * `@agentback/files/testing`'s `runFileStoreConformance`.
 */

import {describe, expect, it} from 'vitest';
import type {Installed} from '@agentback/core';
import type {RestApplication, RestServer} from '@agentback/rest';

export interface InstallConformanceOptions {
  /**
   * Build the app with every prerequisite registered (controllers,
   * components, config) but NOT started. Must use an ephemeral port
   * (`{rest: {port: 0}}`).
   */
  makeApp: () => RestApplication | Promise<RestApplication>;
  /** The install under test. */
  install: (app: RestApplication) => Promise<Installed>;
  /**
   * Paths that answer (2xx/3xx) while installed and 404 after uninstall,
   * checked on both the Express host and the neutral fetch host.
   */
  served: string[];
  /** Paths that must keep serving after uninstall (the app is untouched). */
  untouched?: string[];
}

export function runInstallConformance(
  label: string,
  options: InstallConformanceOptions,
): void {
  const {makeApp, install, served, untouched = []} = options;

  async function boot(): Promise<{
    app: RestApplication;
    installed: Installed;
    server: RestServer;
  }> {
    const app = await makeApp();
    const installed = await install(app);
    await app.start();
    const server = await app.restServer;
    return {app, installed, server};
  }

  describe(`install conformance: ${label}`, () => {
    it('uninstall() retracts every served path on the Express host', async () => {
      const {app, installed, server} = await boot();
      try {
        for (const path of served) {
          const res = await fetch(server.url + path);
          expect(res.status, `${path} while installed`).toBeLessThan(400);
        }

        await installed.uninstall();

        for (const path of served) {
          const res = await fetch(server.url + path);
          expect(res.status, `${path} after uninstall`).toBe(404);
        }
        for (const path of untouched) {
          const res = await fetch(server.url + path);
          expect(res.status, `${path} must stay serving`).toBeLessThan(400);
        }
      } finally {
        await app.stop();
      }
    });

    it('uninstall() retracts every served path on the fetch host', async () => {
      const {app, installed, server} = await boot();
      try {
        const hit = (path: string) =>
          server.fetchHandler().fetch(new Request(`http://conformance${path}`));
        for (const path of served) {
          const res = await hit(path);
          expect(res.status, `${path} while installed`).toBeLessThan(400);
        }

        await installed.uninstall();

        for (const path of served) {
          const res = await hit(path);
          expect(res.status, `${path} after uninstall`).toBe(404);
        }
        for (const path of untouched) {
          const res = await hit(path);
          expect(res.status, `${path} must stay serving`).toBeLessThan(400);
        }
      } finally {
        await app.stop();
      }
    });

    it('uninstall() is idempotent', async () => {
      const {app, installed} = await boot();
      try {
        await installed.uninstall();
        await expect(installed.uninstall()).resolves.toBeUndefined();
      } finally {
        await app.stop();
      }
    });
  });
}
