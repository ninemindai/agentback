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

/**
 * A probe: a GET path, or `{path, init}` for endpoints that need a method,
 * headers, or a body (e.g. an MCP JSON-RPC POST).
 */
export type ServedProbe = string | {path: string; init?: RequestInit};

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
   * Probes that answer (2xx/3xx) while installed and 404 after uninstall,
   * checked on both the Express host and the neutral fetch host.
   */
  served: ServedProbe[];
  /** Probes that must keep serving after uninstall (the app is untouched). */
  untouched?: ServedProbe[];
  /**
   * Which hosts to probe. Defaults to both. A helper that mounts one host
   * per app (e.g. installMcpHttp picks Express vs fetch from
   * `rest.listener`) runs the suite once per host with a matching makeApp.
   */
  hosts?: Array<'express' | 'fetch'>;
}

export function runInstallConformance(
  label: string,
  options: InstallConformanceOptions,
): void {
  const {makeApp, install} = options;
  const norm = (p: ServedProbe) => (typeof p === 'string' ? {path: p} : p);
  const served = options.served.map(norm);
  const untouched = (options.untouched ?? []).map(norm);
  const hosts = options.hosts ?? ['express', 'fetch'];

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
    it.runIf(hosts.includes('express'))(
      'uninstall() retracts every served path on the Express host',
      async () => {
        const {app, installed, server} = await boot();
        const hit = async (p: {path: string; init?: RequestInit}) => {
          const res = await fetch(server.url + p.path, p.init);
          await res.body?.cancel().catch(() => {});
          return res.status;
        };
        try {
          for (const p of served) {
            expect(await hit(p), `${p.path} while installed`).toBeLessThan(400);
          }

          await installed.uninstall();

          for (const p of served) {
            expect(await hit(p), `${p.path} after uninstall`).toBe(404);
          }
          for (const p of untouched) {
            expect(await hit(p), `${p.path} must stay serving`).toBeLessThan(
              400,
            );
          }
        } finally {
          await app.stop();
        }
      },
    );

    it.runIf(hosts.includes('fetch'))(
      'uninstall() retracts every served path on the fetch host',
      async () => {
        const {app, installed, server} = await boot();
        const hit = async (p: {path: string; init?: RequestInit}) => {
          const res = await server
            .fetchHandler()
            .fetch(new Request(`http://conformance${p.path}`, p.init));
          await res.body?.cancel().catch(() => {});
          return res.status;
        };
        try {
          for (const p of served) {
            expect(await hit(p), `${p.path} while installed`).toBeLessThan(400);
          }

          await installed.uninstall();

          for (const p of served) {
            expect(await hit(p), `${p.path} after uninstall`).toBe(404);
          }
          for (const p of untouched) {
            expect(await hit(p), `${p.path} must stay serving`).toBeLessThan(
              400,
            );
          }
        } finally {
          await app.stop();
        }
      },
    );

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
