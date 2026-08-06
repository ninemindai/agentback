// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import semver from 'semver';
import {AgentError, ErrorCodes} from '@agentback/openapi';

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [k: string]: unknown;
}

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
] as const;

/** `^0.9.0` / `~0.9.0` / `0.9.0` → `0.9.0`. Anything else → no match. */
export const RANGE_RE = /^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The override trees a package manager honours: npm/pnpm `overrides`, yarn
 * `resolutions`, and pnpm's `pnpm.overrides`.
 *
 * An override outranks every range in the file, so leaving it behind re-pins
 * the old version after a successful-looking bump — the exact shape of the
 * field failure. npm nests them, so callers walk each tree recursively.
 */
function overrideTrees(
  pkg: PackageJson,
): Array<[string, Record<string, unknown>]> {
  const out: Array<[string, Record<string, unknown>]> = [];
  for (const key of ['overrides', 'resolutions'] as const) {
    if (isRecord(pkg[key])) out.push([key, pkg[key]]);
  }
  const pnpm = pkg.pnpm;
  if (isRecord(pnpm) && isRecord(pnpm.overrides)) {
    out.push(['pnpm.overrides', pnpm.overrides]);
  }
  return out;
}

/** Visit every `<name>: <string>` leaf of an override tree, depth-first. */
function walkOverrides(
  tree: Record<string, unknown>,
  section: string,
  visit: (
    holder: Record<string, unknown>,
    name: string,
    range: string,
    section: string,
  ) => void,
): void {
  for (const [name, value] of Object.entries(tree)) {
    if (typeof value === 'string') visit(tree, name, value, section);
    else if (isRecord(value)) walkOverrides(value, `${section}.${name}`, visit);
  }
}

/**
 * Collect every `@agentback/*` range across all dependency and override
 * sections.
 *
 * Keyed `<section>:<name>`, NOT by name alone: the same package can appear in
 * both `dependencies` and `devDependencies` with different ranges, and a
 * name-keyed map would let the second silently overwrite the first — hiding
 * exactly the version disagreement `resolveFromVersion` exists to report.
 */
export function scanAgentbackRanges(pkg: PackageJson): Map<string, string> {
  const out = new Map<string, string>();
  for (const section of SECTIONS) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      // `workspace:` entries are in-repo and are pnpm's problem, not ours.
      if (!name.startsWith('@agentback/')) continue;
      if (range.startsWith('workspace:')) continue;
      out.set(`${section}:${name}`, range);
    }
  }
  for (const [key, tree] of overrideTrees(pkg)) {
    walkOverrides(tree, key, (_holder, name, range, section) => {
      if (!name.startsWith('@agentback/')) return;
      if (range.startsWith('workspace:')) return;
      out.set(`${section}:${name}`, range);
    });
  }
  return out;
}

/**
 * Version comparison via `semver`, not a hand parser. A hand-rolled
 * `split('.').map(Number)` silently mis-sorts prereleases (`0.10.0-rc.1`), and
 * a lockstep 0.x project cutting an rc is not exotic.
 */
export function compareVersions(a: string, b: string): number {
  return semver.compare(a, b);
}

/**
 * Derive the app's current version from its `@agentback/*` ranges. Lockstep
 * releases mean they agree; disagreement is reported (not fatal) and the
 * LOWEST version wins, so every migration in between still runs.
 */
export function resolveFromVersion(ranges: Map<string, string>): {
  version: string;
  disagreement: string[];
  unparsed: string[];
} {
  const parsed = new Map<string, string>();
  const unparsed: string[] = [];
  for (const [key, range] of ranges) {
    const m = RANGE_RE.exec(range);
    // `latest`, a dist-tag, an `npm:` alias, or a compound range. Recorded,
    // never silently dropped: `bumpRanges` must not rewrite what this could
    // not read.
    if (m) parsed.set(key, m[1]);
    else unparsed.push(key);
  }
  if (parsed.size === 0)
    throw new AgentError(
      'update: no @agentback/* dependency with a concrete version range ' +
        'found in package.json. Run this from an AgentBack app root.',
      {code: ErrorCodes.INVALID_INPUT},
    );

  const distinct = [...new Set(parsed.values())].sort(compareVersions);
  return {
    version: distinct[0],
    disagreement: distinct.length > 1 ? [...parsed.keys()].sort() : [],
    unparsed,
  };
}

/**
 * Rewrite every `@agentback/*` range to `^<to>`. Mutates and returns `pkg`.
 *
 * Skips anything `resolveFromVersion` could not parse. The asymmetry matters:
 * if resolve ignores `"@agentback/core": "latest"` when deriving `from`, bump
 * must not then rewrite it to `^0.10.0` — that mutates a dependency whose
 * intent the tool admitted it did not understand. Reported, not touched.
 */
export function bumpRanges(
  pkg: PackageJson,
  to: string,
): {pkg: PackageJson; changed: string[]; skipped: string[]} {
  const changed: string[] = [];
  const skipped: string[] = [];
  const next = `^${to}`;
  for (const section of SECTIONS) {
    const deps = pkg[section];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (!name.startsWith('@agentback/')) continue;
      if (deps[name].startsWith('workspace:')) continue;
      if (!RANGE_RE.test(deps[name])) {
        skipped.push(`${section}:${name}`);
        continue;
      }
      if (deps[name] === next) continue;
      deps[name] = next;
      changed.push(name);
    }
  }
  for (const [key, tree] of overrideTrees(pkg)) {
    walkOverrides(tree, key, (holder, name, range, section) => {
      if (!name.startsWith('@agentback/')) return;
      if (range.startsWith('workspace:')) return;
      if (!RANGE_RE.test(range)) {
        skipped.push(`${section}:${name}`);
        return;
      }
      if (range === next) return;
      holder[name] = next;
      changed.push(name);
    });
  }
  return {pkg, changed, skipped};
}

/**
 * Detect a JSON file's indentation so a rewrite preserves it.
 *
 * A manifest reflowed from 4-space to 2-space by a dependency bump is the same
 * user-visible damage the codemod path guards against, and scaffolded apps
 * ship no formatter to put it back.
 */
export function detectIndent(source: string): string | number {
  const m = /^[ \t]+/m.exec(source.replace(/^\{[^\n]*\n/, ''));
  if (!m) return 2;
  return m[0].startsWith('\t') ? '\t' : m[0].length;
}
