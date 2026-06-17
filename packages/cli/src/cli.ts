#!/usr/bin/env node
// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AgentError} from '@agentback/openapi';
import {parseDeployArgs} from './args.js';
import {nodeExec} from './exec.js';
import {runVercelDeploy} from './run-vercel.js';

export const USAGE = `agentback — deploy an AgentBack app

Usage:
  agentback deploy vercel [options]

Options:
  --entry <path>            built module exporting the app builder
  --export <name>           builder export name (default: buildApp)
  --prod                    production deploy (default: preview)
  --console                 also deploy the dev console (needs auth or --unsafe-public-console)
  --unsafe-public-console   acknowledge publishing console internals unauthenticated
  --eject                   write api/index.ts + vercel.json, then stop
  --force                   overwrite conflicting vercel.json / api/index.ts
  --dry-run                 generate + preflight only, never deploy
  --verify-path <p>         OpenAPI path to verify (default: /openapi.json)
  --yes                     non-interactive
  -h, --help                show this help
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== 'deploy') {
    console.log(USAGE);
    return cmd ? 1 : 0;
  }
  try {
    const args = parseDeployArgs(rest);
    if (args.help) {
      console.log(USAGE);
      return 0;
    }
    const out = await runVercelDeploy(args, {
      exec: nodeExec,
      fetchFn: globalThis.fetch,
      cwd: process.cwd(),
    });
    if (out.status === 'ejected') {
      console.log(
        'Wrote api/index.ts + vercel.json. Run `vercel deploy` to ship.',
      );
      return 0;
    }
    if (out.status === 'dry-run') {
      console.log(
        'Dry run OK: files generated, preflight passed, nothing deployed.',
      );
      return 0;
    }
    if (out.verify && !out.verify.ok) {
      console.error(
        `Deployed to ${out.url} but verify failed ` +
          `(HTTP ${out.verify.status}): ${out.verify.body ?? ''}`,
      );
      return 1;
    }
    console.log(`Deployed and verified: ${out.url}`);
    return 0;
  } catch (e) {
    if (e instanceof AgentError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

const __filename = fileURLToPath(import.meta.url);
const invokedDirectly =
  process.argv[1] != null && __filename === realpathSync(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then(code => process.exit(code))
    .catch(err => {
      console.error(err?.message ?? err);
      process.exit(1);
    });
}
