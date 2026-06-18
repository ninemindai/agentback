// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {parse, stringify} from 'smol-toml';
import {AgentError, ErrorCodes} from '@agentback/openapi';

// Fixed, reviewed compatibility date (bump deliberately, not silently).
const COMPAT_DATE = '2026-06-01';

export function mergeWrangler(
  existingToml: string | undefined,
  opts: {name: string; main: string; force: boolean; eject: boolean},
): {toml: string; warnings: string[]} {
  const warnings: string[] = [];
  const obj: Record<string, unknown> = existingToml
    ? (parse(existingToml) as Record<string, unknown>)
    : {};

  // `main` is load-bearing: if the user set a different one, don't silently steal it.
  if (typeof obj.main === 'string' && obj.main !== opts.main && !opts.force && !opts.eject) {
    throw new AgentError(
      `wrangler.toml already sets \`main\` to "${obj.main}". Re-run with --force ` +
        `to point it at the generated worker, or --eject to wire it by hand.`,
      {code: ErrorCodes.INVALID_INPUT},
    );
  }
  if (typeof obj.main === 'string' && obj.main !== opts.main && opts.force) {
    warnings.push(`Overwrote wrangler.toml \`main\` ("${obj.main}" → "${opts.main}").`);
  }

  obj.name = obj.name ?? opts.name; // don't clobber a user-chosen name
  obj.main = opts.main;
  obj.compatibility_date = obj.compatibility_date ?? COMPAT_DATE;
  const flags = new Set([
    ...((Array.isArray(obj.compatibility_flags) ? obj.compatibility_flags : []) as string[]),
    'nodejs_compat',
  ]);
  obj.compatibility_flags = [...flags];

  return {toml: stringify(obj) + '\n', warnings};
}
