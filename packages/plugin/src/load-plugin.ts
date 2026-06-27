// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {isAbsolute, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {statSync} from 'node:fs';
import type {Application} from '@agentback/core';
import {
  entryRelative,
  readMarker,
  readPackageJson,
  resolvePackageDir,
} from './discovery.js';
import {appOwnedContext, tryMount} from './mount.js';
import type {LoadPluginOptions, PluginInfo} from './types.js';

/**
 * A specifier is a filesystem path (not a bare package name) when it is
 * relative (`./`, `../`), absolute, or an explicit `file:` URL. Scoped/bare
 * npm names (`@acme/foo`, `foo`) fall through to module resolution.
 */
function isPathSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:') ||
    isAbsolute(specifier)
  );
}

/** Build a `PluginInfo` for an unmarked package dir given an explicit component. */
function infoFromDir(dir: string, component: string): PluginInfo {
  const pkg = readPackageJson(dir);
  return {
    name: pkg?.name ?? dir,
    version: pkg?.version ?? '0.0.0',
    component,
    source: 'dir',
    path: dir,
    importSpecifier: pathToFileURL(resolve(dir, entryRelative(pkg ?? {}))).href,
  };
}

/**
 * Resolve a specifier (bare npm name OR filesystem path) into a `PluginInfo`.
 * Reuses the marker reader when a marker is present; an explicit `component`
 * overrides the marker and is *required* for unmarked targets.
 */
export async function resolvePlugin(
  specifier: string,
  cwd: string,
  component?: string,
): Promise<PluginInfo> {
  if (isPathSpecifier(specifier)) {
    const abs = specifier.startsWith('file:')
      ? fileURLToPath(specifier)
      : isAbsolute(specifier)
        ? specifier
        : resolve(cwd, specifier);
    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      throw new Error(`cannot resolve plugin path "${specifier}"`);
    }
    if (isDir) {
      const marked = readMarker(abs, 'dir');
      if (marked) return component ? {...marked, component} : marked;
      if (!component) {
        throw new Error(
          `"${specifier}" has no agentback marker; pass {component} to loadPlugin`,
        );
      }
      return infoFromDir(abs, component);
    }
    // A bare file path has no package.json to read a component name from.
    if (!component) {
      throw new Error(
        `"${specifier}" is a file; pass {component} to loadPlugin to name its export`,
      );
    }
    return {
      name: abs,
      version: '0.0.0',
      component,
      source: 'dir',
      path: dirname(abs),
      importSpecifier: pathToFileURL(abs).href,
    };
  }

  const parentURL = pathToFileURL(resolve(cwd, 'package.json')).href;
  const dir = await resolvePackageDir(specifier, parentURL);
  if (!dir) throw new Error(`cannot resolve plugin "${specifier}"`);
  const marked = readMarker(dir, 'deps', specifier);
  if (marked) return component ? {...marked, component} : marked;
  if (!component) {
    throw new Error(
      `"${specifier}" has no agentback marker; pass {component} to loadPlugin`,
    );
  }
  const pkg = readPackageJson(dir);
  return {
    name: pkg?.name ?? specifier,
    version: pkg?.version ?? '0.0.0',
    component,
    source: 'deps',
    path: dir,
    importSpecifier: specifier,
  };
}

/**
 * Imperatively mount a single plugin by npm specifier OR filesystem path,
 * independent of the `package.json` dependency graph that `loadPlugins`
 * discovers from. The target need not be a declared dependency and need not
 * carry an `agentback` marker (pass `{component}` when it doesn't).
 *
 * Keeps the same fail-closed governance as `loadPlugins`: a re-bind of a key
 * already owned by the app throws unless listed in `options.allowOverride`.
 * Returns the mounted `PluginInfo`; throws on import / missing-export /
 * collision failure.
 */
export async function loadPlugin(
  app: Application,
  specifier: string,
  options: LoadPluginOptions = {},
): Promise<PluginInfo> {
  const cwd = options.cwd ?? process.cwd();
  const info = await resolvePlugin(specifier, cwd, options.component);
  const ctx = appOwnedContext(app, options.allowOverride ?? []);
  const err = await tryMount(app, info, ctx);
  if (err) {
    const e = new Error(
      `[plugin:${err.package}] ${err.kind}: ${err.message}`,
    ) as Error & {error?: typeof err};
    e.error = err;
    throw e;
  }
  return info;
}
