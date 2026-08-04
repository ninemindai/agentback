// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm';

const MANAGERS = ['pnpm', 'yarn', 'bun', 'npm'] as const;

/**
 * Ordered so the most specific lockfile wins — a repo carrying both
 * `package-lock.json` and `pnpm-lock.yaml` is a pnpm repo with a stale npm
 * lockfile, not the other way around.
 */
const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

/**
 * Detect the app's package manager. Deliberately NOT `create-agentback`'s
 * `detectPackageManager()` — that reads the invoking manager from npm's
 * user-agent, which is always npm under `npx`, and `npx` is the primary way
 * `update` is run.
 *
 * `packageManager` wins over lockfiles: it is Corepack's declared source of
 * truth, so it states intent, while a lockfile is a side effect that can be
 * stale or committed by accident.
 */
export function detectAppPackageManager(root: string): PackageManager {
  const declared = readPackageManagerField(root);
  if (declared) return declared;
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(path.join(root, file))) return pm;
  }
  return 'npm';
}

/** Read the Corepack `packageManager` field, e.g. `"pnpm@11.2.0"`. */
function readPackageManagerField(root: string): PackageManager | undefined {
  const pkgPath = path.join(root, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  let field: unknown;
  try {
    field = (
      JSON.parse(readFileSync(pkgPath, 'utf8')) as {packageManager?: unknown}
    ).packageManager;
  } catch {
    // A malformed package.json is phase 1's problem to report, not ours.
    return undefined;
  }
  if (typeof field !== 'string') return undefined;
  const name = field.split('@')[0];
  return MANAGERS.find(p => p === name);
}

export function installCommand(pm: PackageManager): {
  cmd: string;
  args: string[];
} {
  // Windows package managers are `.cmd` shims, and `spawn()` without `shell`
  // cannot execute them — it fails ENOENT on a manager that is definitely
  // installed. `deploy` has the same latent issue, but `update` puts it on the
  // primary path for every Windows user, so resolve the real name here.
  const cmd = process.platform === 'win32' ? `${pm}.cmd` : pm;
  return {cmd, args: ['install']};
}
