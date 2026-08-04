// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import type {UpdateArgs} from '../args.js';
import type {Exec} from '../exec.js';
import type {Finding, Migration, MigrationContext} from './migration.js';
import {selectMigrations} from './migration.js';
import {MIGRATIONS} from './migrations/index.js';
import {detectAppPackageManager, installCommand} from './package-manager.js';
import {createLazyProject} from './project.js';
import {
  bumpRanges,
  compareVersions,
  detectIndent,
  resolveFromVersion,
  scanAgentbackRanges,
  type PackageJson,
} from './versions.js';

export interface UpdateDeps {
  exec: Exec;
  cwd: string;
  selfVersion: string;
  /**
   * Registry override. Defaults to the shipped `MIGRATIONS`. Injectable so a
   * fake migration can prove the `apply` seam — ordering, dry-run skip, and
   * failure handling — without waiting for a real codemod to exist.
   */
  migrations?: readonly Migration[];
}

export interface UpdateReport {
  from: string;
  to: string;
  changed: string[];
  /** `@agentback/*` entries whose range was too complex to read or rewrite. */
  skipped: string[];
  unparsed: string[];
  disagreement: string[];
  /** Non-fatal conditions the user must see (e.g. the git guard could not run). */
  warnings: string[];
  findings: Array<Finding & {migration: string}>;
  installed: boolean;
  dryRun: boolean;
}

/**
 * @returns a warning when the guard could not run. Git is the undo mechanism
 * for this command, so "we could not check" is a fact the user needs — not the
 * same thing as "there is nothing to protect". Silently treating every git
 * failure (missing binary, permission error, corrupt index) as safe is how a
 * safety guard becomes decorative.
 */
async function assertCleanTree(
  exec: Exec,
  cwd: string,
): Promise<string | undefined> {
  const r = await exec('git', ['-C', cwd, 'status', '--porcelain']);
  if (r.code !== 0) {
    return (
      `Could not verify the git working tree (git exited ${r.code}). ` +
      'Proceeding without an undo checkpoint.'
    );
  }
  if (r.stdout.trim() === '') return undefined;
  throw new AgentError(
    'update: the working tree has uncommitted changes. Commit or stash first ' +
      'so you can undo this update with git, or re-run with --force.',
    {code: ErrorCodes.INVALID_INPUT},
  );
}

export async function runUpdate(
  args: UpdateArgs,
  deps: UpdateDeps,
): Promise<UpdateReport> {
  const {cwd, exec, selfVersion} = deps;
  const to = args.to ?? selfVersion;

  // Lockstep versioning means the CLI installed in a 0.9 app cannot contain
  // the 0.9 -> 0.10 migration; that entry only exists in the 0.10 release.
  if (compareVersions(selfVersion, to) < 0) {
    throw new AgentError(
      `update: this CLI is ${selfVersion} and cannot migrate to ${to} — the ` +
        'migrations for that release ship with it. Run ' +
        '`npx @agentback/cli@latest update` instead.',
      {code: ErrorCodes.INVALID_INPUT},
    );
  }

  const warnings: string[] = [];
  if (!args.dryRun && !args.force) {
    const w = await assertCleanTree(exec, cwd);
    if (w) warnings.push(w);
  }

  // --- Phase 1: resolve -------------------------------------------------
  const pkgPath = path.join(cwd, 'package.json');
  const source = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(source) as PackageJson;
  const {
    version: from,
    disagreement,
    unparsed,
  } = resolveFromVersion(scanAgentbackRanges(pkg));

  // A command named `update` must not quietly walk an app backwards. Migration
  // direction is undefined going down, and (from, to] selects nothing — so a
  // downgrade would report "no migration notes" and look like it worked.
  if (compareVersions(to, from) < 0 && !args.force) {
    throw new AgentError(
      `update: ${to} is older than the app's current ${from}. Re-run with ` +
        '--force to downgrade; no migrations run in that direction.',
      {code: ErrorCodes.INVALID_INPUT},
    );
  }

  // --- Phase 2: migrate (BEFORE the bump — see below) -------------------
  //
  // Ordering is load-bearing, not stylistic. If the bump+install ran first and
  // install failed, package.json would already say `to` — so the next run
  // resolves `from` as the NEW version, computes an empty (from, to] window,
  // and silently skips every migration forever. Migrating first makes a failed
  // install harmless: package.json still says `from`, so a re-run repeats the
  // same detection and then retries the bump.
  const findings: Array<Finding & {migration: string}> = [];
  const ctx: MigrationContext = {
    root: cwd,
    pkg,
    project: createLazyProject(cwd),
    from,
    to,
  };
  for (const m of selectMigrations(deps.migrations ?? MIGRATIONS, from, to)) {
    for (const f of m.detect(ctx)) findings.push({...f, migration: m.id});
    if (m.apply && !args.dryRun) m.apply(ctx);
  }

  // --- Phase 3: bump + install ------------------------------------------
  const {pkg: bumped, changed, skipped} = bumpRanges(pkg, to);
  let installed = false;
  if (!args.dryRun && changed.length) {
    // Preserve the file's own indentation. The codemod path guards source
    // formatting because scaffolded apps ship no prettier; a manifest
    // rewritten from 4-space to 2-space is the same damage from the same cause.
    writeFileSync(
      pkgPath,
      JSON.stringify(bumped, null, detectIndent(source)) + '\n',
    );
    const {cmd, args: iargs} = installCommand(detectAppPackageManager(cwd));
    const r = await exec(cmd, iargs);
    if (r.code !== 0)
      throw new AgentError(
        `update: \`${cmd} ${iargs.join(' ')}\` failed with code ${r.code}. ` +
          'package.json has been bumped and migrations already ran; re-run ' +
          'install manually.',
        {code: ErrorCodes.INVALID_INPUT},
      );
    installed = true;
  }

  return {
    from,
    to,
    changed,
    skipped,
    unparsed,
    disagreement,
    warnings,
    findings,
    installed,
    dryRun: args.dryRun,
  };
}

/**
 * Render a report for the terminal. Returns the process exit code.
 *
 * `console.log`, not `loggers()`: AgentBack's loggers are debug-namespaced, so
 * `log.warn` emits nothing unless `DEBUG` matches. A CLI's primary output must
 * not depend on an env var being set.
 */
export function printUpdateReport(
  r: UpdateReport,
  out: (s: string) => void = console.log,
): number {
  if (r.dryRun) out('Dry run — nothing was written.\n');
  out(`${r.from} → ${r.to}`);

  for (const w of r.warnings) out(`\nWarning: ${w}`);

  if (r.disagreement.length)
    out(
      `\nWarning: @agentback/* versions disagreed (${r.disagreement.join(', ')}). ` +
        `Used the lowest (${r.from}) so no migration is skipped.`,
    );

  if (r.skipped.length)
    out(
      '\nLeft alone (range too complex to rewrite safely):\n  ' +
        r.skipped.join('\n  ') +
        '\n  Update these by hand.',
    );

  out(
    r.changed.length
      ? `\nBumped ${r.changed.length} dependencies:\n  ${r.changed.join('\n  ')}`
      : '\nNo dependency ranges needed changing.',
  );

  if (!r.findings.length) {
    out('\nNo migration notes for this range.');
    return 0;
  }

  out(`\n${r.findings.length} migration note(s):`);
  for (const f of r.findings) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(app)';
    out(`\n  [${f.migration}] ${where}`);
    out(`    ${f.message}`);
    out(`    → ${f.action}`);
  }
  return 0;
}
