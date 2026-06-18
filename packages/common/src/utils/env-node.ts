// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Node-only env helpers: dotenv loading, filesystem-based utilities.
// This file MUST NOT be imported from Workers/browser bundles.
// It is re-exported from utils/index.ts (tree-shaken by bundlers that do not
// reach it via the static graph of loggers / debug-factory).

import {config, DotenvConfigOutput, DotenvParseOutput} from 'dotenv';
import fs from 'node:fs';
import Module, {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Allow override via MONOREPO_ROOT_PATH env var (for wrapper repos that embed
// this workspace), otherwise navigate from packages/common/src/utils/ up to monorepo root
const monorepoRoot =
  process.env.MONOREPO_ROOT_PATH ??
  path.resolve(import.meta.dirname, '../../../../');

/**
 * Get the env file suffix based on NODE_ENV.
 * Maps NODE_ENV values to short file suffixes.
 * Defaults to 'dev' if NODE_ENV is not set.
 */
function getEnvFileSuffix(): string {
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv) return 'dev'; // Default to dev environment

  switch (nodeEnv.toLowerCase()) {
    case 'production':
    case 'prod':
      return 'production';
    case 'development':
    case 'dev':
      return 'dev';
    case 'staging':
      return 'staging';
    case 'qa':
      return 'qa';
    case 'test':
      return 'test';
    default:
      return nodeEnv; // Use as-is for custom environments
  }
}

/**
 * Load environment variables from cascading .env files.
 *
 * Precedence (highest to lowest):
 * 1. Explicit env vars (CLI, Docker, etc.) - always preserved
 * 2. .env.{NODE_ENV} (e.g., .env.production, .env.dev)
 * 3. .env.local - local developer overrides (gitignored)
 * 4. .env - common defaults
 *
 * Files are loaded in reverse priority order with override: false,
 * so the first value set wins (and process.env values are never overwritten).
 *
 * @returns Object with merged `parsed` containing all loaded env vars
 */
export function loadEnvFiles(): DotenvConfigOutput {
  const envSuffix = getEnvFileSuffix();
  const merged: DotenvParseOutput = {};

  // Load in reverse priority order (most specific first)
  // override: false means first loaded value wins, and process.env is preserved
  const files = [
    `.env.${envSuffix}`, // e.g., .env.production, .env.dev
    '.env.local', // local overrides (gitignored)
    '.env', // common defaults
  ];

  // Load files and merge parsed values (first value wins for duplicates)
  for (const file of files) {
    const filePath = path.resolve(monorepoRoot, file);
    if (fs.existsSync(filePath)) {
      const result = config({path: filePath, quiet: true});
      if (result.parsed) {
        // Merge: existing keys take precedence (first loaded wins)
        for (const [key, value] of Object.entries(result.parsed)) {
          if (!(key in merged)) {
            merged[key] = value;
          }
        }
      }
    }
  }

  return {parsed: merged};
}

// Load .env files from monorepo root with cascading precedence.
// This runs eagerly on import — Node apps get auto-loading by importing this
// module (which utils/index.ts does via `export * from './env-node.js'`).
// Bundlers targeting Workers/browser never reach this module through the
// loggers/debug-factory static graph, so they never bundle dotenv/fs/path.
export const DOTENV_CONFIG: DotenvConfigOutput = loadEnvFiles();

/**
 * Strip the extension from a filename if it has one.
 * @param name - A filename.
 * @return The filename without a path.
 */
export function stripExt(name: string) {
  const extension = path.extname(name);
  if (!extension) {
    return name;
  }

  return name.slice(0, -extension.length);
}

/**
 * Check if the given module is the main entry
 * @param module - `import.meta.url` for ESM or `module` for CommonJS
 * @returns
 */
export function isMain(module: string | Module | ImportMeta) {
  if (typeof module === 'object' && 'url' in module && 'main' in module) {
    // ESM environment
    return module.main;
  } else if (typeof module !== 'string') {
    return require.main === module;
  } else {
    const require = createRequire(module);
    const scriptPath = require.resolve(process.argv[1]);
    const modulePath = fileURLToPath(module);
    const extension = path.extname(scriptPath);
    if (extension) {
      return modulePath === scriptPath;
    }
    return stripExt(modulePath) === scriptPath;
  }
}
