#!/usr/bin/env node
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AgentError} from '@agentback/openapi';
import {parseDeployArgs, parseNewArgs, parseUpdateArgs} from './args.js';
import {runNew} from './new.js';
import {printUpdateReport, runUpdate} from './update/run-update.js';
import {selfVersion} from './version.js';
import {nodeExec} from './exec.js';
import {runDeploy} from './run-deploy.js';
import {vercelTarget} from './targets/vercel.js';
import {cloudflareTarget} from './targets/cloudflare.js';

export const USAGE = `agentback — scaffold, deploy, and upgrade an AgentBack app
(also available as \`abc\`)

Usage:
  agentback new <name> [--template hybrid|rest|mcp] [--with <caps>]
  agentback deploy (vercel|cloudflare) [options]
  agentback update [--to <version>] [--dry-run] [--force]
  agentback --version

Run \`agentback <command> --help\` for command-specific options.

Exit codes: 0 success, 1 failure. Migration notes are advisory and do NOT
change the exit code; \`update\`'s post-install version audit does.
`;

export const UPDATE_USAGE = `agentback update — upgrade an app across an AgentBack release

Usage:
  agentback update [--to <version>] [--dry-run] [--force]

Options:
  --to <version>   exact target version (default: this CLI's version)
  --dry-run        report findings and the intended bump; write nothing
  --force          proceed on a dirty git tree, and permit a downgrade
  -h, --help       show this help

Because releases are lockstep, the migrations for a release ship with it — run
\`npx @agentback/cli@latest update\` to migrate to the newest version.

Run it from the workspace ROOT: every phase covers sub-package manifests, their
sources, and pnpm-workspace.yaml overrides. After installing, it audits the tree
and exits 1 if any @agentback/* still resolves below the target.
`;

export const NEW_USAGE = `agentback new — scaffold a new AgentBack app

Usage:
  agentback new <name> [options]

Options:
  -t, --template <name>   hybrid (default), rest, or mcp
  --with <caps>           comma-separated add-ons (console, drizzle, auth)
  --drizzle               shorthand for --with drizzle
  --auth                  shorthand for --with auth
  -c, --console           shorthand for --with console
  --port <n>              REST server port (rest|hybrid)
  --host <h>              REST server host (rest|hybrid)
  --base-path <p>         REST base path (rest|hybrid)
  -h, --help              show this help

This delegates to create-agentback. For the interactive wizard, run
\`npm create agentback\` instead — \`agentback new\` requires a name.
`;

export const DEPLOY_USAGE = `agentback deploy — deploy an AgentBack app

Usage:
  agentback deploy (vercel|cloudflare) [options]

Options:
  --entry <path>            built module exporting the app builder
  --export <name>           builder export name (default: buildApp)
  --prod                    production deploy (default: preview)
  --temporary               cloudflare: deploy to a throwaway preview account
                            (no signup/auth; expires in 60 min — must run unauthenticated)
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
  try {
    // `--version` is table stakes for any CLI, and load-bearing for this one:
    // `update` refuses when the CLI is older than its target and tells the user
    // to compare versions, which is unanswerable without this.
    if (cmd === '--version' || cmd === '-v') {
      console.log(selfVersion());
      return 0;
    }
    if (cmd === 'new') {
      const args = parseNewArgs(rest);
      if (args.help) {
        console.log(NEW_USAGE);
        return 0;
      }
      const dir = runNew(args, {cwd: process.cwd()});
      console.log(`Created ${dir}`);
      console.log(
        `Next: cd ${path.basename(dir)} && npm install && npm run build && npm start`,
      );
      return 0;
    }
    if (cmd === 'deploy') return await runDeployCommand(rest);
    if (cmd === 'update') {
      const args = parseUpdateArgs(rest);
      if (args.help) {
        console.log(UPDATE_USAGE);
        return 0;
      }
      const report = await runUpdate(args, {
        exec: nodeExec,
        cwd: process.cwd(),
        selfVersion: selfVersion(),
      });
      return printUpdateReport(report);
    }
    console.log(USAGE);
    return cmd ? 1 : 0;
  } catch (e) {
    if (e instanceof AgentError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

async function runDeployCommand(rest: string[]): Promise<number> {
  const args = parseDeployArgs(rest);
  if (args.help) {
    console.log(DEPLOY_USAGE);
    return 0;
  }
  {
    const target =
      args.target === 'cloudflare' ? cloudflareTarget : vercelTarget;
    const out = await runDeploy(args, target, {
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
