// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';
import type {UpdateArgs} from '../args.js';
import type {Exec} from '../exec.js';
import {auditVersions, type StalePin} from './audit.js';
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
import {discoverWorkspace, readYamlPins, rewriteYamlPins} from './workspace.js';

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
  /**
   * Post-install audit: `@agentback/*` still resolving below the target.
   * Non-empty ⇒ the update did NOT fully land ⇒ exit 1.
   */
  stale: StalePin[];
  /**
   * The app's install command, e.g. `pnpm install`. Carried on the report so
   * the audit can tell a user with a stale `node_modules` what to actually run
   * — "fix the pin sites" is unactionable when there are no stale pin sites.
   */
  installHint?: string;
  installed: boolean;
  dryRun: boolean;
}

/** One `package.json` the update owns, with the bytes it was read from. */
interface Manifest {
  path: string;
  /** Root-relative path, or `''` for the root manifest. */
  rel: string;
  source: string;
  pkg: PackageJson;
}

/**
 * Prefix a report entry with the file it came from. The root manifest keeps the
 * bare form it has always had — a single-package app is the common case and its
 * output should not grow a redundant `package.json:` on every line.
 */
function site(rel: string, entry: string): string {
  return rel ? `${rel}:${entry}` : entry;
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
  //
  // Every manifest in the workspace, not just the root: real apps keep their
  // `@agentback/*` pins in sub-packages, and a pnpm `overrides` block outranks
  // all of them. Resolving across the whole topology keeps "the lowest wins so
  // no migration is skipped" true of the app rather than of one file.
  const workspace = discoverWorkspace(cwd);
  // The root manifest anchors everything downstream — it is `ctx.pkg` for every
  // migration and the file `rel` paths are relative to. Without this guard a
  // rootless directory would silently promote whichever sub-package sorted
  // first into that role, and detection would reason about the wrong app.
  if (!existsSync(workspace.manifests[0])) {
    throw new AgentError(
      `update: no package.json in ${cwd}. Run this from an AgentBack app ` +
        'root (or, in a workspace, from the workspace root).',
      {code: ErrorCodes.INVALID_INPUT},
    );
  }
  const manifests: Manifest[] = workspace.manifests
    .filter(p => existsSync(p))
    .map(p => {
      const source = readFileSync(p, 'utf8');
      return {
        path: p,
        rel: p === workspace.manifests[0] ? '' : path.relative(cwd, p),
        source,
        pkg: JSON.parse(source) as PackageJson,
      };
    });
  const pkg = manifests[0].pkg;

  const yamlSource = workspace.pnpmWorkspace
    ? readFileSync(workspace.pnpmWorkspace, 'utf8')
    : undefined;

  const ranges = new Map<string, string>();
  for (const m of manifests) {
    for (const [key, range] of scanAgentbackRanges(m.pkg)) {
      ranges.set(site(m.rel, key), range);
    }
  }
  if (yamlSource) {
    // Block-qualified keys, so a package pinned in both `overrides:` and
    // `catalog:` contributes BOTH versions to the min-over-everything.
    for (const [key, range] of readYamlPins(yamlSource)) {
      ranges.set(`pnpm-workspace.yaml:${key}`, range);
    }
  }
  const {version: from, disagreement, unparsed} = resolveFromVersion(ranges);

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
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const m of manifests) {
    const r = bumpRanges(m.pkg, to);
    skipped.push(...r.skipped.map(k => site(m.rel, k)));
    if (!r.changed.length) continue;
    changed.push(...r.changed.map(n => site(m.rel, n)));
    // Preserve the file's own indentation. The codemod path guards source
    // formatting because scaffolded apps ship no prettier; a manifest
    // rewritten from 4-space to 2-space is the same damage from the same cause.
    if (!args.dryRun) {
      writeFileSync(
        m.path,
        JSON.stringify(m.pkg, null, detectIndent(m.source)) + '\n',
      );
    }
  }
  if (yamlSource && workspace.pnpmWorkspace) {
    // An override left at the old version re-pins every package the bump just
    // moved — the failure that made a green field upgrade resolve 0.7.1.
    const y = rewriteYamlPins(yamlSource, to);
    changed.push(...y.changed.map(n => `pnpm-workspace.yaml:${n}`));
    skipped.push(...y.skipped.map(n => `pnpm-workspace.yaml:${n}`));
    if (!args.dryRun && y.changed.length) {
      writeFileSync(workspace.pnpmWorkspace, y.text);
    }
  }

  const {cmd, args: iargs} = installCommand(detectAppPackageManager(cwd));
  let installed = false;
  if (!args.dryRun && changed.length) {
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

  // --- Phase 4: audit ---------------------------------------------------
  //
  // All three workspace gaps this command shipped with failed QUIET — each one
  // looked like a successful update. The audit re-derives what is on disk from
  // different parts than the bump used (see `auditVersions`), so it can catch
  // the enumerator's own blind spots rather than agreeing with them.
  const stale = args.dryRun ? [] : auditVersions(cwd, to);

  return {
    from,
    to,
    changed,
    skipped,
    unparsed,
    disagreement,
    warnings,
    findings,
    stale,
    installHint: `${cmd} ${iargs.join(' ')}`,
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

  if (!r.findings.length) out('\nNo migration notes for this range.');
  else {
    out(`\n${r.findings.length} migration note(s):`);
    for (const f of r.findings) {
      const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '(app)';
      out(`\n  [${f.migration}] ${where}`);
      out(`    ${f.message}`);
      out(`    → ${f.action}`);
    }
  }

  // The one thing in this report that changes the exit code. Migration notes
  // are advisory; a version still resolving below the target means the update
  // did not land, and a lifecycle tool that returns 0 for that is the quiet
  // failure this whole phase exists to end.
  if (!r.stale.length) return 0;
  out(
    `\nUPDATE INCOMPLETE — ${r.stale.length} @agentback/* version(s) still ` +
      `below ${r.to}:`,
  );

  // The two halves need different instructions. A stale pin is something the
  // user edits; a stale node_modules is something a package manager fixes — and
  // when the pins are already at target nothing changed, so no install ran.
  // Telling that user to "fix the sites above and re-run" reproduces the
  // identical failure forever.
  const installedSite = (s: StalePin) =>
    s.site.split(/[\\/]/).includes('node_modules');
  const pins = r.stale.filter(s => !installedSite(s));
  const trees = r.stale.filter(installedSite);

  if (pins.length) {
    out('\n  Pinned below target — edit these, then re-run:');
    for (const s of pins) out(`    ${s.site}  ${s.name} ${s.found}`);
    out(
      '\n  A stale pin or override holds the old version silently — 0.x ' +
        'carets cannot cross a minor.',
    );
  }
  if (trees.length) {
    out('\n  Installed below target — the dependency tree is stale:');
    for (const s of trees) out(`    ${s.site}  ${s.name} ${s.found}`);
    out(
      `\n  Run \`${r.installHint ?? 'npm install'}\`` +
        (pins.length ? ' after fixing the pins above.' : '.'),
    );
  }
  return 1;
}
