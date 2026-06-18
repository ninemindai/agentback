// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, isAbsolute, parse as parsePath, resolve} from 'node:path';
import type {z} from 'zod';
import {resolveEnvVarsInObject} from './env-vars.js';
import {parseConfigText, SUPPORTED_EXTENSIONS} from './parsers.js';

const log = loggers('agentback:config');

/** Thrown when a loaded config fails its Zod schema. */
export class ConfigValidationError extends Error {
  constructor(
    public readonly filename: string,
    public readonly zodError: z.ZodError,
  ) {
    const issues = zodError.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    super(`Invalid config ${filename}:\n${issues}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Resolve the config directory.
 *
 *   1. `CONFIG_DIR` env var (resolved against `PROJECT_ROOT` or cwd)
 *   2. `PROJECT_ROOT/config`
 *   3. `cwd/config`
 */
export function getConfigDir(): string {
  const root = process.env.PROJECT_ROOT ?? process.cwd();
  const explicit = process.env.CONFIG_DIR;
  const dir = explicit ? resolve(root, explicit) : resolve(root, 'config');
  log.debug('config dir: %s', dir);
  return dir;
}

/** Current environment name. `NODE_ENV` or `'development'`. */
export function getEnv(): string {
  return process.env.NODE_ENV ?? 'development';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Two-level shallow merge tuned for `{section: {entry: {...}}}` config shapes.
 *
 * - Root-level entries: recurse one level when both sides are plain objects.
 * - Within a section: per-entry `Object.assign`; arrays and primitives replace.
 * - No deep merge into nested objects or arrays.
 */
export function shallowMergeConfigs(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {...base};
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(result[key]) && isPlainObject(value)) {
      const section: Record<string, unknown> = {
        ...(result[key] as Record<string, unknown>),
      };
      for (const [entryKey, entryValue] of Object.entries(value)) {
        if (isPlainObject(section[entryKey]) && isPlainObject(entryValue)) {
          section[entryKey] = {
            ...(section[entryKey] as Record<string, unknown>),
            ...(entryValue as Record<string, unknown>),
          };
        } else {
          section[entryKey] = entryValue;
        }
      }
      result[key] = section;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Overlay filenames for `base`, in merge order (later wins):
 *   `name.{env}.{ext}` then `name.local.{ext}`
 */
function getOverlayFilenames(filename: string): string[] {
  const {name, ext} = parsePath(filename);
  const env = getEnv();
  return [`${name}.${env}${ext}`, `${name}.local${ext}`];
}

/** Resolve `filename` to an absolute path under `configDir` (if not already). */
function resolveConfigPath(filename: string, configDir: string): string {
  return isAbsolute(filename) ? filename : resolve(configDir, filename);
}

/**
 * Look up `filename` under the config dir, trying its given extension first
 * and then each supported extension. Returns the absolute path or `undefined`.
 */
function findConfigFile(
  filename: string,
  configDir: string,
): string | undefined {
  const explicit = resolveConfigPath(filename, configDir);
  if (existsSync(explicit)) return explicit;
  if (parsePath(filename).ext) return undefined;
  for (const ext of SUPPORTED_EXTENSIONS) {
    const candidate = resolveConfigPath(`${filename}${ext}`, configDir);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Load `filename` from the config dir, merge env/local overlays, then resolve
 * `${ENV}` references. No schema validation. Returns `undefined` if the base
 * file is missing.
 */
export function loadRawConfigFile(filename: string): unknown | undefined {
  const configDir = getConfigDir();
  const basePath = findConfigFile(filename, configDir);
  if (!basePath) return undefined;

  let merged = parseConfigText<Record<string, unknown>>(
    readFileSync(basePath, 'utf-8'),
    basePath,
  );
  log.debug('loaded base config: %s', basePath);

  const baseDir = dirname(basePath);
  for (const overlayName of getOverlayFilenames(basePath)) {
    const overlayPath = resolve(baseDir, overlayName);
    if (!existsSync(overlayPath)) continue;
    const overlay = parseConfigText<Record<string, unknown>>(
      readFileSync(overlayPath, 'utf-8'),
      overlayPath,
    );
    merged = shallowMergeConfigs(merged, overlay);
    log.debug('applied overlay: %s', overlayPath);
  }

  return resolveEnvVarsInObject(merged);
}

/**
 * Load `filename`, apply overlays + env-var resolution, then validate against
 * `schema`. Throws `ConfigValidationError` on schema failure and a plain Error
 * if the file is missing.
 */
export function loadConfigFile<T>(filename: string, schema: z.ZodType<T>): T {
  const raw = loadRawConfigFile(filename);
  if (raw === undefined) {
    throw new Error(
      `Config file not found: ${resolveConfigPath(filename, getConfigDir())}`,
    );
  }
  const result = schema.safeParse(raw);
  if (!result.success) throw new ConfigValidationError(filename, result.error);
  log.debug('validated %s', filename);
  return result.data;
}
