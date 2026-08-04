// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {scaffold} from 'create-agentback';
import type {NewArgs} from './args.js';

/**
 * Scaffold a new app by delegating to `create-agentback`. The CLI never
 * reimplements or copies templates — `create-agentback` stays the single
 * source of truth, and `npm create agentback` remains the idiomatic entry.
 *
 * Deliberately non-interactive: `create-agentback` prompts when run with no
 * name on a TTY, but this delegate errors and points there instead (see
 * `parseNewArgs`). Two entry points behaving differently on the same input is
 * worse than one of them being explicitly narrower.
 *
 * @returns the created app directory.
 */
export function runNew(args: NewArgs, deps: {cwd: string}): string {
  const {dir} = scaffold({
    name: args.name,
    template: args.template,
    cwd: deps.cwd,
    capabilities: args.capabilities,
    host: args.host,
  });
  return dir;
}
