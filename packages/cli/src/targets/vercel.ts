// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AgentError, ErrorCodes} from '@agentback/openapi';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import type {DeployArgs} from '../args.js';
import {generateEntry} from '../generate-entry.js';
import {mergeVercelConfig} from '../merge-config.js';
import type {
  DeployTarget,
  Diagnostic,
  FileEdit,
  GenerateOpts,
  RunDeps,
} from '../deploy-target.js';

function detectPackageManager(): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  return 'npm';
}

function parseUrl(stdout: string): string {
  const m = stdout.match(/https:\/\/\S+\.vercel\.app/);
  if (!m) {
    throw new AgentError('Could not find a deployment URL in vercel output.', {
      code: ErrorCodes.INVALID_INPUT,
    });
  }
  return m[0];
}

export const vercelTarget: DeployTarget = {
  id: 'vercel',

  generateEntry(o: GenerateOpts): FileEdit {
    const stripped = o.builder.entry.replace(/^\.\//, '');
    const entryFromApi = stripped.startsWith('/') ? stripped : '../' + stripped;
    const contents = generateEntry({
      entry: entryFromApi,
      exportName: o.builder.exportName,
    });
    return {path: 'api/index.ts', contents};
  },

  generateConfig(o: GenerateOpts): FileEdit[] {
    const vercelPath = path.join(o.cwd, 'vercel.json');
    const existing = existsSync(vercelPath)
      ? (JSON.parse(readFileSync(vercelPath, 'utf8')) as Record<
          string,
          unknown
        >)
      : undefined;
    const {json, warnings} = mergeVercelConfig(existing, {
      packageManager: detectPackageManager(),
      includeConsoleAssets: o.isConsoleBuilder,
      force: o.force,
      eject: o.eject,
    });
    for (const w of warnings) console.warn(`warning: ${w}`);
    return [
      {path: 'vercel.json', contents: JSON.stringify(json, null, 2) + '\n'},
    ];
  },

  async preflight(_o: GenerateOpts, deps: RunDeps): Promise<Diagnostic[]> {
    const who = await deps.exec('vercel', ['whoami']);
    if (who.code !== 0) {
      throw new AgentError(
        'Vercel CLI is not installed or not authenticated. Install with ' +
          '`npm i -g vercel`, then run `vercel login` (and `vercel link`).',
        {code: ErrorCodes.INVALID_INPUT},
      );
    }
    return [{ok: true, message: 'authenticated'}];
  },

  async deploy(args: DeployArgs, deps: RunDeps): Promise<{url: string}> {
    const deployArgs = [
      'deploy',
      ...(args.prod ? ['--prod'] : []),
      ...(args.yes ? ['--yes'] : []),
    ];
    const res = await deps.exec('vercel', deployArgs);
    if (res.code !== 0) {
      throw new AgentError(`vercel deploy failed (exit ${res.code}).`, {
        code: ErrorCodes.INVALID_INPUT,
      });
    }
    return {url: parseUrl(res.stdout)};
  },

  defaultVerifyPath(): string {
    return '/openapi.json';
  },
};
