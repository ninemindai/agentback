// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AgentError, ErrorCodes} from '@agentback/openapi';

export interface MergeOpts {
  packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm';
  includeConsoleAssets: boolean;
  force: boolean;
  eject: boolean;
}
export interface MergeResult {
  json: Record<string, unknown>;
  warnings: string[];
}

const CANONICAL_REWRITE = {source: '/(.*)', destination: '/api'};
const CONSOLE_INCLUDE =
  'node_modules/{@agentback/console/dist/client,swagger-ui-dist}/**';

export function mergeVercelConfig(
  existing: Record<string, unknown> | undefined,
  opts: MergeOpts,
): MergeResult {
  const warnings: string[] = [];
  const json: Record<string, unknown> = {...(existing ?? {})};

  // functions.api/index.ts — merge, adding includeFiles only for the console.
  const fns = {...((json.functions as Record<string, unknown>) ?? {})};
  const entry = {...((fns['api/index.ts'] as Record<string, unknown>) ?? {})};
  if (opts.includeConsoleAssets) entry.includeFiles = CONSOLE_INCLUDE;
  else delete entry.includeFiles;
  fns['api/index.ts'] = entry;
  json.functions = fns;

  // rewrites — ORDERED array. Our catch-all must own the whole surface, so we
  // cannot safely interleave with a user's existing rules. Conflict unless the
  // user opted in via --force/--eject.
  const existingRewrites = existing?.rewrites;
  const isCanonical =
    Array.isArray(existingRewrites) &&
    existingRewrites.length === 1 &&
    JSON.stringify(existingRewrites[0]) === JSON.stringify(CANONICAL_REWRITE);
  if (
    Array.isArray(existingRewrites) &&
    existingRewrites.length > 0 &&
    !isCanonical
  ) {
    if (!opts.force && !opts.eject) {
      throw new AgentError(
        'vercel.json already defines `rewrites`. A catch-all rewrite would ' +
          'override them. Re-run with --force to overwrite, or --eject to ' +
          'merge by hand.',
        {code: ErrorCodes.INVALID_INPUT},
      );
    }
    if (opts.force) warnings.push('Overwrote existing vercel.json `rewrites`.');
  }
  json.rewrites = [CANONICAL_REWRITE];

  return {json, warnings};
}
