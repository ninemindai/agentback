// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import type {DeployArgs} from '../args.js';
import type {
  DeployTarget,
  GenerateOpts,
  RunDeps,
  Diagnostic,
  FileEdit,
} from '../deploy-target.js';
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
    const existing = existsSync(wranglerPath)
      ? readFileSync(wranglerPath, 'utf8')
      : undefined;
    const name = readName(o.cwd);
    const {toml, warnings} = mergeWrangler(existing, {
      name,
      main: WORKER_PATH,
      force: o.force,
      eject: o.eject,
    });
    for (const w of warnings) console.warn(`warning: ${w}`);
    return [{path: 'wrangler.toml', contents: toml}];
  },

  async preflight(o: GenerateOpts, _deps: RunDeps): Promise<Diagnostic[]> {
    return [await runBundleDoctor(path.join(o.cwd, WORKER_PATH))];
  },

  async deploy(args: DeployArgs, deps: RunDeps): Promise<{url: string}> {
    if (args.prod) {
      console.warn(
        'warning: Cloudflare Workers has a single deploy environment; --prod has no effect.',
      );
    }
    // `--temporary` provisions a throwaway preview account on the fly, so it
    // requires the *inverse* of the normal flow: wrangler refuses it when you
    // are authenticated (or CLOUDFLARE_API_TOKEN is set). Skip the whoami gate
    // — a CI runner is naturally unauthenticated — and let wrangler enforce it.
    if (!args.temporary) {
      const who = await deps.exec('wrangler', ['whoami']);
      if (who.code !== 0) {
        throw new AgentError(
          'Wrangler is not installed or not authenticated. Install with ' +
            '`npm i -g wrangler`, then run `wrangler login` (or pass ' +
            '`--temporary` to deploy to a throwaway preview account).',
          {code: ErrorCodes.INVALID_INPUT},
        );
      }
    }
    const res = await deps.exec(
      'wrangler',
      args.temporary ? ['deploy', '--temporary'] : ['deploy'],
    );
    if (res.code !== 0) {
      const hint = args.temporary
        ? ' `--temporary` only works unauthenticated — log out and unset ' +
          'CLOUDFLARE_API_TOKEN first.'
        : '';
      throw new AgentError(
        `wrangler deploy failed (exit ${res.code}).${hint}`,
        {
          code: ErrorCodes.INVALID_INPUT,
        },
      );
    }
    const m = res.stdout.match(/https:\/\/\S+\.workers\.dev\S*/);
    if (!m)
      throw new AgentError(
        'Could not find a workers.dev URL in wrangler output.',
        {code: ErrorCodes.INVALID_INPUT},
      );
    return {url: m[0].replace(/[.,)]+$/, '')};
  },

  defaultVerifyPath() {
    return '/openapi.json';
  },
};

function readName(cwd: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    ) as {name?: string};
    return (pkg.name ?? 'agentback-worker').replace(/^@[^/]+\//, '');
  } catch {
    return 'agentback-worker';
  }
}
