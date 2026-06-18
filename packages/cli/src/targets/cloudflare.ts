// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import type {DeployArgs} from '../args.js';
import type {DeployTarget, GenerateOpts, RunDeps, Diagnostic, FileEdit} from '../deploy-target.js';
import {generateWorker} from '../generate-worker.js';
import {mergeWrangler} from '../merge-wrangler.js';
import {runBundleDoctor} from '../bundle-doctor.js'; // Task 5

const WORKER_PATH = '.agentback/deploy/cloudflare/worker.ts';

// Root-relative entry → relative to the worker's 3-deep location.
function entryFromWorker(entry: string): string {
  const stripped = entry.replace(/^\.\//, '');
  return stripped.startsWith('/') ? stripped : '../../../' + stripped;
}

export const cloudflareTarget: DeployTarget = {
  id: 'cloudflare',

  generateEntry(o: GenerateOpts): FileEdit {
    return {
      path: WORKER_PATH,
      contents: generateWorker({
        entry: entryFromWorker(o.builder.entry),
        exportName: o.builder.exportName,
      }),
    };
  },

  generateConfig(o: GenerateOpts): FileEdit[] {
    const wranglerPath = path.join(o.cwd, 'wrangler.toml');
    const existing = existsSync(wranglerPath) ? readFileSync(wranglerPath, 'utf8') : undefined;
    const name = readName(o.cwd);
    const {toml, warnings} = mergeWrangler(existing, {
      name, main: WORKER_PATH, force: o.force, eject: o.eject,
    });
    for (const w of warnings) console.warn(`warning: ${w}`);
    return [{path: 'wrangler.toml', contents: toml}];
  },

  async preflight(o: GenerateOpts, deps: RunDeps): Promise<Diagnostic[]> {
    const diags: Diagnostic[] = [];
    // 1. Bundle doctor (static, before deploy).
    diags.push(await runBundleDoctor(path.join(o.cwd, WORKER_PATH)));
    // 2. wrangler installed + authed.
    diags.push({ok: true, message: ''}); // placeholder; real exec check below in deploy preflight
    return diags;
  },

  async deploy(args: DeployArgs, deps: RunDeps): Promise<{url: string}> {
    const who = await deps.exec('wrangler', ['whoami']);
    if (who.code !== 0) {
      throw new AgentError(
        'Wrangler is not installed or not authenticated. Install with ' +
          '`npm i -g wrangler`, then run `wrangler login`.',
        {code: ErrorCodes.INVALID_INPUT},
      );
    }
    const res = await deps.exec('wrangler', ['deploy', ...(args.prod ? [] : ['--env', 'preview'])]);
    if (res.code !== 0) {
      throw new AgentError(`wrangler deploy failed (exit ${res.code}).`, {code: ErrorCodes.INVALID_INPUT});
    }
    const m = res.stdout.match(/https:\/\/\S+\.workers\.dev\S*/);
    if (!m) throw new AgentError('Could not find a workers.dev URL in wrangler output.', {code: ErrorCodes.INVALID_INPUT});
    return {url: m[0]};
  },

  defaultVerifyPath() {
    return '/openapi.json';
  },
};

function readName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {name?: string};
    return (pkg.name ?? 'agentback-worker').replace(/^@[^/]+\//, '');
  } catch {
    return 'agentback-worker';
  }
}
