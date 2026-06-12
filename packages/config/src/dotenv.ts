// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from 'dotenv';
import {getEnv} from './config-loader.js';

const log = loggers('agentback:config');

export interface LoadEnvFilesOptions {
  /**
   * Directory holding the .env files. Defaults to `process.env.PROJECT_ROOT`
   * or the current working directory.
   */
  dir?: string;
  /**
   * When `false` (default), existing `process.env` entries win — `.env` is a
   * developer fallback, not an override. Set `true` to let `.env.local` and
   * env-specific files clobber whatever was already exported.
   */
  override?: boolean;
}

/**
 * Load `.env` files in cascade order (later wins if `override`):
 *
 *   1. `.env`
 *   2. `.env.{NODE_ENV}`
 *   3. `.env.local`
 *
 * Returns the merged record of values that were applied to `process.env`.
 * Call this once at process startup, before reading any env-dependent code
 * (including `getConfigDir()` or `loadConfigFile()`).
 */
export function loadEnvFiles(
  options: LoadEnvFilesOptions = {},
): Record<string, string> {
  const dir = options.dir ?? process.env.PROJECT_ROOT ?? process.cwd();
  const override = options.override ?? false;
  const env = getEnv();

  const filenames = ['.env', `.env.${env}`, '.env.local'];
  const merged: Record<string, string> = {};

  for (const filename of filenames) {
    const path = resolve(dir, filename);
    if (!existsSync(path)) continue;
    const parsed = parse(readFileSync(path, 'utf-8'));
    for (const [key, value] of Object.entries(parsed)) {
      merged[key] = value;
      if (override || process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    log.debug('loaded env file: %s', path);
  }

  return merged;
}
