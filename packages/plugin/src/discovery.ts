// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {PluginInfo, PluginPackageMarker} from './types.js';
import type {PluginsConfigResolved} from './config.js';

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  agentback?: Partial<PluginPackageMarker>;
}

function readPackageJson(pkgDir: string): PackageJson | null {
  const file = resolve(pkgDir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function entryRelative(pkg: PackageJson): string {
  const exp = pkg.exports as string | Record<string, unknown> | undefined;
  const dot =
    exp && typeof exp === 'object'
      ? (exp as Record<string, unknown>)['.']
      : exp;
  if (typeof dot === 'string') return dot;
  if (dot && typeof dot === 'object') {
    const o = dot as Record<string, unknown>;
    const cond = o.import ?? o.default ?? o.node;
    if (typeof cond === 'string') return cond;
  }
  return pkg.main ?? 'index.js';
}

/**
 * Read the `agentback` marker from a package directory OFF DISK.
 * Returns null when the dir has no package.json, no marker, or an invalid marker.
 */
export function readMarker(
  pkgDir: string,
  source: 'deps' | 'dir',
  bareSpecifier?: string,
): PluginInfo | null {
  const pkg = readPackageJson(pkgDir);
  if (!pkg) return null;
  const marker = pkg['agentback'];
  if (
    !marker ||
    marker.plugin !== true ||
    typeof marker.component !== 'string'
  ) {
    return null;
  }
  const importSpecifier =
    source === 'deps'
      ? (bareSpecifier ?? pkg.name ?? pkgDir)
      : pathToFileURL(resolve(pkgDir, entryRelative(pkg))).href;
  return {
    name: pkg.name ?? pkgDir,
    version: pkg.version ?? '0.0.0',
    component: marker.component,
    source,
    path: pkgDir,
    importSpecifier,
  };
}

/**
 * Resolve a bare specifier to its package directory WITHOUT touching
 * `pkg/package.json` through module resolution (that throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED against restrictive `exports` maps).
 */
export async function resolvePackageDir(
  specifier: string,
  parentURL: string,
): Promise<string | null> {
  let entryUrl: string;
  try {
    entryUrl = import.meta.resolve(specifier, parentURL);
  } catch {
    return null;
  }
  let dir = dirname(fileURLToPath(entryUrl));
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Discover marked plugins from the app's declared dependencies. */
export async function discoverFromDeps(cwd: string): Promise<PluginInfo[]> {
  const appPkg = readPackageJson(cwd);
  const deps = Object.keys(appPkg?.dependencies ?? {});
  const parentURL = pathToFileURL(resolve(cwd, 'package.json')).href;
  const out: PluginInfo[] = [];
  for (const dep of deps) {
    const dir = await resolvePackageDir(dep, parentURL);
    if (!dir) continue;
    const info = readMarker(dir, 'deps', dep);
    if (info) out.push(info);
  }
  return out;
}

/** Discover marked plugins by scanning each dir's immediate subdirectories. */
export function discoverFromDirs(
  dirs: string[],
  cwd: string,
  warnings: string[],
): PluginInfo[] {
  const out: PluginInfo[] = [];
  for (const d of dirs) {
    const abs = isAbsolute(d) ? d : resolve(cwd, d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      warnings.push(
        `plugins.dirs: "${d}" is missing or not a directory; skipped`,
      );
      continue;
    }
    for (const entry of readdirSync(abs)) {
      const sub = resolve(abs, entry);
      // A dangling symlink (or a TOCTOU unlink) makes statSync throw; skip the
      // entry rather than aborting the whole scan in a governance loader.
      try {
        if (!statSync(sub).isDirectory()) continue;
      } catch {
        continue;
      }
      const info = readMarker(sub, 'dir');
      if (info) out.push(info);
    }
  }
  return out;
}

/** Run both discovery sources per config into a deduped candidate set. */
export async function discover(
  config: PluginsConfigResolved,
  cwd: string,
  warnings: string[],
): Promise<PluginInfo[]> {
  const found: PluginInfo[] = [];
  if (config.scan) found.push(...(await discoverFromDeps(cwd)));
  if (config.dirs.length) {
    found.push(...discoverFromDirs(config.dirs, cwd, warnings));
  }
  const seen = new Set<string>();
  const deduped: PluginInfo[] = [];
  for (const info of found) {
    if (seen.has(info.name)) continue;
    seen.add(info.name);
    deduped.push(info);
  }
  return deduped;
}
