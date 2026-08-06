// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import semver from 'semver';

export interface StalePin {
  /** Where the stale version lives, app-root-relative. */
  site: string;
  name: string;
  /** The range or version actually found there. */
  found: string;
}

/** How deep the walk looks for manifests before giving up. */
const MAX_DEPTH = 6;

const VERSION_RE = /^[\^~]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * After the install: find every `@agentback/*` that still resolves BELOW the
 * target, and say where.
 *
 * This is the net, and it is deliberately built from different parts than the
 * bump phase — a net woven from the same enumeration cannot catch that
 * enumeration's own bugs, which is precisely how three workspace gaps each
 * shipped looking like a successful update:
 *
 * - **Manifests come from a filesystem walk, not workspace globs.** A package
 *   no glob covers (or a glob syntax `discoverWorkspace` misread) is invisible
 *   to the bump and visible here.
 * - **Pins come from a deep scan of the whole manifest**, not a section list.
 *   An override key nobody enumerated still gets checked.
 * - **`pnpm-workspace.yaml` is matched anywhere in the file**, including the
 *   flow style the rewriter refuses to touch.
 * - **`node_modules` is read directly**, so the question answered is "what did
 *   the package manager actually install", not "what do we believe we asked
 *   for".
 *
 * Only a version strictly BELOW the target counts. Ahead is fine (a caret
 * resolving `0.10.1` for a `0.10.0` target is the normal outcome), and a range
 * the tool cannot read is left to the bump phase's `skipped` report rather than
 * guessed at twice.
 */
export function auditVersions(root: string, to: string): StalePin[] {
  const stale: StalePin[] = [];
  const rel = (p: string) => path.relative(root, p) || path.basename(p);

  for (const dir of walkDirs(root, MAX_DEPTH)) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      for (const [name, range] of readManifestPins(manifest)) {
        if (below(range, to))
          stale.push({site: rel(manifest), name, found: range});
      }
    }
    for (const installed of readInstalled(dir)) {
      if (below(installed.version, to)) {
        stale.push({
          site: rel(installed.file),
          name: installed.name,
          found: installed.version,
        });
      }
    }
  }

  const yaml = path.join(root, 'pnpm-workspace.yaml');
  if (existsSync(yaml)) {
    for (const [name, range] of readYamlVersions(readFileSync(yaml, 'utf8'))) {
      if (below(range, to)) {
        stale.push({site: 'pnpm-workspace.yaml', name, found: range});
      }
    }
  }
  return stale;
}

function below(found: string, to: string): boolean {
  const m = VERSION_RE.exec(found);
  return m ? semver.lt(m[1], to) : false;
}

/**
 * Own directory walk rather than the workspace enumerator's — the duplication
 * is the point (see `auditVersions`). Skips `node_modules` as a walk target;
 * `readInstalled` reaches into it deliberately.
 */
function walkDirs(dir: string, depth: number): string[] {
  const out = [dir];
  if (depth <= 0) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir, {withFileTypes: true})
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => n !== 'node_modules' && !n.startsWith('.'));
  } catch {
    return out;
  }
  for (const name of entries) {
    out.push(...walkDirs(path.join(dir, name), depth - 1));
  }
  return out;
}

/**
 * Every `"@agentback/*": "<string>"` entry anywhere in a manifest, at any
 * depth. No section list: an entry in a section the bump phase never heard of
 * is exactly the failure this exists to catch.
 */
function readManifestPins(file: string): Array<[string, string]> {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // Reporting a parse error here would blame the audit for a file the app
    // owns; phase 1 already fails loudly on an unreadable root manifest.
    return [];
  }
  const out: Array<[string, string]> = [];
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node))
      return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string') {
        if (key.startsWith('@agentback/') && !value.startsWith('workspace:')) {
          out.push([key, value]);
        }
      } else visit(value);
    }
  };
  visit(json);
  return out;
}

/** Installed `@agentback/*` packages directly under `<dir>/node_modules`. */
function readInstalled(
  dir: string,
): Array<{name: string; version: string; file: string}> {
  const scope = path.join(dir, 'node_modules', '@agentback');
  let names: string[] = [];
  try {
    names = readdirSync(scope);
  } catch {
    return [];
  }
  const out: Array<{name: string; version: string; file: string}> = [];
  for (const name of names) {
    const file = path.join(scope, name, 'package.json');
    try {
      const version = (
        JSON.parse(readFileSync(file, 'utf8')) as {version?: unknown}
      ).version;
      if (typeof version === 'string') {
        out.push({name: `@agentback/${name}`, version, file});
      }
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * `@agentback/*` versions anywhere in a `pnpm-workspace.yaml` — overrides,
 * catalogs, and the flow-style shapes the rewriter deliberately refuses. Match
 * on the raw text, not the rewriter's line grammar, so a pin it could not parse
 * is still audited.
 */
function readYamlVersions(source: string): Array<[string, string]> {
  const re =
    /(@agentback\/[A-Za-z0-9._-]+)['"]?[ \t]*:[ \t]*['"]?([\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g;
  return [...source.matchAll(re)].map(m => [m[1], m[2]]);
}
