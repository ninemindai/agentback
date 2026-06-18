// Copyright (c) 2024 AgentBack contributors. MIT License.

import {mkdtempSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {runDeploy} from '../../run-deploy.js';
import {cloudflareTarget} from '../../targets/cloudflare.js';
import type {DeployArgs} from '../../args.js';
import type {RunDeps} from '../../deploy-target.js';

// When compiled, this file lives at:
//   packages/cli/dist/__tests__/integration/deploy-cloudflare.integration.js
// Must be INSIDE the CLI package tree so esbuild can walk up to find
// packages/cli/node_modules/@agentback/rest when bundling the worker.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// dist/__tests__/integration → dist
const cliDist = resolve(__dirname, '../..');

describe('runDeploy cloudflare (dry-run, real esbuild preflight)', () => {
  let tmpDir: string;

  beforeAll(() => {
    // Must be inside the CLI dist tree so esbuild resolves workspace packages.
    tmpDir = mkdtempSync(join(cliDist, '.deploy-cf-integration-'));

    // Write a minimal package.json so resolveBuilder can read the app name.
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({name: 'fixture-cf-app', version: '0.0.1'}),
    );

    // Write an edge-safe buildApp that does NOT import RestApplication (Express).
    // It uses @agentback/rest's low-level createFetchHost which is edge-safe and
    // produces an object whose fetchHandler() method satisfies the worker template.
    // The worker template calls:
    //   const app = await buildApp({listen:false});
    //   const server = await app.restServer;
    //   return server.fetchHandler();
    const distDir = join(tmpDir, 'dist');
    mkdirSync(distDir, {recursive: true});
    writeFileSync(
      join(distDir, 'main.js'),
      [
        `import {createFetchHost} from '@agentback/rest';`,
        `export async function buildApp(_opts) {`,
        `  const host = createFetchHost({`,
        `    router: {match: () => null},`,
        `    dispatch: () => Promise.resolve(new Response('ok')),`,
        `  });`,
        `  const server = { fetchHandler() { return host; } };`,
        `  return { get restServer() { return Promise.resolve(server); } };`,
        `}`,
      ].join('\n'),
    );
  });

  afterAll(() => {
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it('dry-run returns {status: "dry-run"} without invoking exec', async () => {
    const args: DeployArgs = {
      target: 'cloudflare',
      // No --entry: resolveBuilder probes dist/main.js first, which we wrote above.
      entry: undefined,
      exportName: 'buildApp',
      prod: false,
      console: false,
      unsafePublicConsole: false,
      eject: false,
      force: true,
      dryRun: true,
      yes: true,
      verifyPath: '/openapi.json',
      help: false,
    };

    // exec MUST NOT be called in dry-run mode (wrangler is only called in
    // target.deploy(), which dry-run never reaches).
    const deps: RunDeps = {
      exec: () => {
        throw new Error('exec must not be called during dry-run');
      },
      fetchFn: globalThis.fetch,
      cwd: tmpDir,
    };

    const result = await runDeploy(args, cloudflareTarget, deps);
    expect(result.status).toBe('dry-run');
    expect(result.url).toBeUndefined();
  }, 60_000);
});
