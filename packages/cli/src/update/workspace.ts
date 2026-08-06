// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {RANGE_RE} from './versions.js';

export interface WorkspaceLayout {
  /** Every `package.json` the update owns, ROOT FIRST. Absolute paths. */
  manifests: string[];
  /** Absolute path to `pnpm-workspace.yaml`, when the repo has one. */
  pnpmWorkspace?: string;
}

/** How deep a `**` segment or a bare workspace root is allowed to recurse. */
const MAX_DEPTH = 8;

/**
 * Enumerate the app's workspace topology from static file reads only.
 *
 * Both real-world upgrades that motivated this kept their `@agentback/*` pins —
 * and their source — in workspace sub-packages, so a root-only update rewrote
 * nothing that mattered and left `^0.7.1` resolving under a 0.10 headline.
 *
 * pnpm globs and npm/yarn `workspaces` are merged rather than treated as
 * alternatives: a repo carrying both is not a contradiction to resolve, it is
 * two lists of packages that both need bumping.
 */
export function discoverWorkspace(root: string): WorkspaceLayout {
  const manifests = [path.join(root, 'package.json')];
  const pnpmWorkspace = path.join(root, 'pnpm-workspace.yaml');
  const hasPnpm = existsSync(pnpmWorkspace);

  const patterns = [
    ...(hasPnpm ? readPnpmPackages(readFileSync(pnpmWorkspace, 'utf8')) : []),
    ...readManifestWorkspaces(root),
  ];

  const positive = patterns.filter(p => !p.startsWith('!'));
  const negative = new Set(
    patterns
      .filter(p => p.startsWith('!'))
      .flatMap(p => expandGlob(root, p.slice(1))),
  );

  const dirs = new Set<string>();
  for (const p of positive) {
    for (const dir of expandGlob(root, p)) {
      if (dir === root || negative.has(dir)) continue;
      if (existsSync(path.join(dir, 'package.json'))) dirs.add(dir);
    }
  }
  for (const dir of [...dirs].sort()) {
    manifests.push(path.join(dir, 'package.json'));
  }
  return {manifests, ...(hasPnpm ? {pnpmWorkspace} : {})};
}

/** `workspaces: [...]` or `workspaces: {packages: [...]}` from package.json. */
function readManifestWorkspaces(root: string): string[] {
  const file = path.join(root, 'package.json');
  if (!existsSync(file)) return [];
  let field: unknown;
  try {
    field = (JSON.parse(readFileSync(file, 'utf8')) as {workspaces?: unknown})
      .workspaces;
  } catch {
    // A malformed root manifest is phase 1's problem to report, not ours.
    return [];
  }
  const list = Array.isArray(field)
    ? field
    : ((field as {packages?: unknown} | null)?.packages ?? []);
  return Array.isArray(list) ? list.filter(x => typeof x === 'string') : [];
}

/**
 * The `packages:` list out of `pnpm-workspace.yaml`, block or flow style.
 *
 * Hand-read rather than parsed: `@agentback/cli` is invoked through `npx`, so
 * every dependency is downloaded on every run, and a YAML library is a large
 * price for two shapes of one key. The cost is honesty — anything this cannot
 * read yields no packages rather than a wrong list, and the post-update audit
 * (which never consults this) is what catches the difference.
 */
function readPnpmPackages(source: string): string[] {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^packages:[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[1].trim().startsWith('[')) {
      out.push(...m[1].replace(/^\[|\].*$/g, '').split(','));
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      const item = /^[ \t]+-[ \t]*(.+?)[ \t]*(?:#.*)?$/.exec(line);
      if (!item) break;
      out.push(item[1]);
    }
  }
  return out.map(unquote).filter(Boolean);
}

function unquote(s: string): string {
  return s.trim().replace(/^['"]|['"]$/g, '');
}

/** Directories matching a workspace glob. Never descends `node_modules`. */
function expandGlob(root: string, pattern: string): string[] {
  const segments = pattern.split('/').filter(s => s !== '' && s !== '.');
  let dirs = [root];
  for (const seg of segments) {
    const next: string[] = [];
    for (const dir of dirs) {
      if (seg === '**') {
        next.push(dir, ...descendants(dir, MAX_DEPTH));
      } else if (seg.includes('*') || seg.includes('?')) {
        const re = segmentMatcher(seg);
        for (const name of childDirs(dir)) {
          if (re.test(name)) next.push(path.join(dir, name));
        }
      } else if (existsSync(path.join(dir, seg))) {
        next.push(path.join(dir, seg));
      }
    }
    dirs = [...new Set(next)];
  }
  return dirs;
}

function segmentMatcher(seg: string): RegExp {
  const body = seg
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${body}$`);
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, {withFileTypes: true})
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => n !== 'node_modules' && !n.startsWith('.'));
  } catch {
    return [];
  }
}

function descendants(dir: string, depth: number): string[] {
  if (depth <= 0) return [];
  const out: string[] = [];
  for (const name of childDirs(dir)) {
    const child = path.join(dir, name);
    out.push(child, ...descendants(child, depth - 1));
  }
  return out;
}

/**
 * A `<name>: <range>` mapping entry for an `@agentback/*` package.
 *
 * Deliberately not scoped to the `overrides:` block. `overrides`, `catalog`,
 * and `catalogs` all re-pin a version and all fail the same silent way, and in
 * `pnpm-workspace.yaml` nothing else has this shape — `packages:` holds a
 * sequence of globs, which cannot match (the `- ` breaks it).
 *
 * YAML reserves a leading `@`, so real files always quote these keys; the
 * optional quote group is tolerance, not a supported style.
 */
const YAML_PIN_RE =
  /^([ \t]*)(['"]?)(@agentback\/[A-Za-z0-9._-]+)\2([ \t]*:[ \t]*)(['"]?)([^'"\s#]+)\5([ \t]*(?:#.*)?)$/;

const YAML_NAME_RE = /@agentback\/[A-Za-z0-9._-]+/g;

/** A `key:` line opening a nested block — `overrides:`, `catalogs:`, `web:`. */
const YAML_BLOCK_RE = /^([ \t]*)['"]?([A-Za-z0-9_.-]+)['"]?:[ \t]*(?:#.*)?$/;

/**
 * Joins block names into the path half of a pin's key. NOT `.`: a literal
 * top-level key `'catalogs.web':` would then produce the same key as a real
 * `catalogs:` → `web:` nesting, and the second would overwrite the first in the
 * caller's range map — the same silent-drop this function exists to prevent.
 * `YAML_BLOCK_RE` admits only `[A-Za-z0-9_.-]`, so neither the space nor the
 * `>` can occur inside a name and the separator is unambiguous by construction.
 */
const BLOCK_SEP = ' > ';

/**
 * Every `@agentback/*` version pin in a `pnpm-workspace.yaml`, as
 * `[<block path>:<name>, range]` pairs — **a list, not a name-keyed map**.
 *
 * The same package can be pinned in `overrides:` and again in `catalog:` (or in
 * two named `catalogs:` entries) at different versions. Keying by name alone
 * would let the last one seen silently overwrite the first, and if that one is
 * the higher version, `from` resolves too high and every migration in the gap
 * is skipped. This is the same rule `scanAgentbackRanges` follows for the
 * dependency sections, for the same reason.
 */
export function readYamlPins(source: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const stack: Array<{indent: number; name: string}> = [];
  for (const line of source.split('\n')) {
    const block = YAML_BLOCK_RE.exec(line);
    if (block) {
      const indent = block[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
      stack.push({indent, name: block[2]});
      continue;
    }
    const m = YAML_PIN_RE.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const path = stack
      .filter(s => s.indent < indent)
      .map(s => s.name)
      .join(BLOCK_SEP);
    out.push([path ? `${path}:${m[3]}` : m[3], m[6]]);
  }
  return out;
}

/**
 * Rewrite every readable `@agentback/*` pin to `^<to>`, as a line-targeted
 * edit — every other byte of the file, including quote style, alignment and
 * trailing comments, is carried over untouched. Apps ship no formatter, so a
 * reflowed workspace file is permanent, user-visible damage.
 *
 * @returns `skipped` names for pins it saw but would not rewrite (an unreadable
 * range, or a flow-style block). Silence there is what made the field failure
 * look like a success.
 */
export function rewriteYamlPins(
  source: string,
  to: string,
): {text: string; changed: string[]; skipped: string[]} {
  const changed: string[] = [];
  const skipped = new Set<string>();
  const lines = source.split('\n').map(line => {
    const m = YAML_PIN_RE.exec(line);
    if (!m) {
      if (!line.trim().startsWith('#')) {
        for (const name of line.match(YAML_NAME_RE) ?? []) skipped.add(name);
      }
      return line;
    }
    const [, indent, kq, name, sep, vq, range, tail] = m;
    if (!RANGE_RE.test(range)) {
      skipped.add(name);
      return line;
    }
    if (range === `^${to}`) return line;
    changed.push(name);
    return `${indent}${kq}${name}${kq}${sep}${vq}^${to}${vq}${tail}`;
  });
  return {text: lines.join('\n'), changed, skipped: [...skipped]};
}
