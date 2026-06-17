// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AgentError, ErrorCodes} from '@agentback/openapi';

export interface DeployArgs {
  target: 'vercel';
  entry?: string;
  exportName?: string;
  name?: string;
  prod: boolean;
  console: boolean;
  unsafePublicConsole: boolean;
  eject: boolean;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  verifyPath: string;
  help: boolean;
}

const VALUE_FLAGS = new Set([
  '--entry', '--export', '--name', '--verify-path',
]);
const BOOL_FLAGS = new Set([
  '--prod', '--console', '--unsafe-public-console', '--eject', '--force',
  '--dry-run', '--yes', '-h', '--help',
]);

function bad(message: string): never {
  throw new AgentError(message, {code: ErrorCodes.INVALID_INPUT});
}

export function parseDeployArgs(argv: string[]): DeployArgs {
  const [target, ...rest] = argv;
  if (!target) bad('deploy: missing target. Usage: agentback deploy vercel');
  if (target !== 'vercel') bad(`deploy: unknown target '${target}' (only 'vercel' in Phase 1)`);

  const out: DeployArgs = {
    target: 'vercel', prod: false, console: false, unsafePublicConsole: false,
    eject: false, force: false, dryRun: false, yes: false,
    verifyPath: '/openapi.json', help: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (VALUE_FLAGS.has(f)) {
      const v = rest[++i];
      if (v === undefined) bad(`deploy: ${f} needs a value`);
      if (f === '--entry') out.entry = v;
      else if (f === '--export') out.exportName = v;
      else if (f === '--name') out.name = v;
      else if (f === '--verify-path') out.verifyPath = v;
    } else if (BOOL_FLAGS.has(f)) {
      if (f === '--prod') out.prod = true;
      else if (f === '--console') out.console = true;
      else if (f === '--unsafe-public-console') out.unsafePublicConsole = true;
      else if (f === '--eject') out.eject = true;
      else if (f === '--force') out.force = true;
      else if (f === '--dry-run') out.dryRun = true;
      else if (f === '--yes') out.yes = true;
      else if (f === '-h' || f === '--help') out.help = true;
    } else {
      bad(`deploy: unknown flag '${f}'`);
    }
  }
  return out;
}
