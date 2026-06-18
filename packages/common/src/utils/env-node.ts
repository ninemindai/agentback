// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/mit/

// Node-only env helpers: dotenv loading, filesystem-based utilities.
// Node dependencies (dotenv, node:fs, node:path, node:module) are resolved
// at RUNTIME inside loadEnvFiles() — never via static top-level imports —
// so bundlers (esbuild platform:browser) see NO static edge to those modules
// from the barrel, keeping the graph clean for Workers / browser bundles.

// ---------------------------------------------------------------------------
// Runtime-only type helpers (TypeScript types only — erased at compile time)
// ---------------------------------------------------------------------------
// We still need type information for the return shape of loadEnvFiles().
// DotenvConfigOutput / DotenvParseOutput are pure TypeScript interfaces with
// no runtime footprint, so we can import them as `import type`.
import type {DotenvConfigOutput, DotenvParseOutput} from 'dotenv';

// ---------------------------------------------------------------------------
// loadEnvFiles
// ---------------------------------------------------------------------------

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
 * Node deps (dotenv, node:fs, node:path) are resolved at runtime via
 * process.getBuiltinModule / createRequire so they never appear in the static
 * module graph — the function is safe to barrel-export from @agentback/common.
 *
 * On non-Node runtimes (Workers, browser) the function returns immediately
 * with an empty parsed object.
 *
 * @returns Object with merged `parsed` containing all loaded env vars
 */
export function loadEnvFiles(): DotenvConfigOutput {
  // --- Non-Node guard --------------------------------------------------
  // On Cloudflare Workers / browser, process is undefined or has no .versions.
  // Return the same empty shape used when no .env files are present.
  if (typeof process === 'undefined' || !process.versions?.node) {
    return {parsed: {}};
  }

  // --- Runtime-resolve Node builtins -----------------------------------
  // process.getBuiltinModule is available on Node ≥ 22.13 (our engine floor).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _process = process as any;
  const fs = _process.getBuiltinModule('node:fs') as typeof import('node:fs');
  const path = _process.getBuiltinModule(
    'node:path',
  ) as typeof import('node:path');
  const nodeModule = _process.getBuiltinModule(
    'node:module',
  ) as typeof import('node:module');

  // --- Runtime-require dotenv (npm package, not a builtin) -------------
  const require = nodeModule.createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const {config} = require('dotenv') as typeof import('dotenv');

  // --- Resolve monorepo root -------------------------------------------
  // Allow override via MONOREPO_ROOT_PATH env var (for wrapper repos that embed
  // this workspace), otherwise navigate from packages/common/src/utils/ up to
  // monorepo root.
  const monorepoRoot =
    process.env.MONOREPO_ROOT_PATH ??
    path.resolve(import.meta.dirname, '../../../../');

  // --- Determine env suffix from NODE_ENV ------------------------------
  const nodeEnv = process.env.NODE_ENV;
  let envSuffix: string;
  if (!nodeEnv) {
    envSuffix = 'dev';
  } else {
    switch (nodeEnv.toLowerCase()) {
      case 'production':
      case 'prod':
        envSuffix = 'production';
        break;
      case 'development':
      case 'dev':
        envSuffix = 'dev';
        break;
      case 'staging':
        envSuffix = 'staging';
        break;
      case 'qa':
        envSuffix = 'qa';
        break;
      case 'test':
        envSuffix = 'test';
        break;
      default:
        envSuffix = nodeEnv;
    }
  }

  // --- Load files in reverse priority order (most specific first) ------
  const merged: DotenvParseOutput = {};
  const files = [
    `.env.${envSuffix}`, // e.g., .env.production, .env.dev
    '.env.local', // local overrides (gitignored)
    '.env', // common defaults
  ];

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
// On Workers/browser, loadEnvFiles() is a safe no-op (returns {parsed: {}}).
export const DOTENV_CONFIG: DotenvConfigOutput = loadEnvFiles();

// ---------------------------------------------------------------------------
// stripExt / isMain — these also use Node modules, resolved at call-time
// ---------------------------------------------------------------------------

/**
 * Strip the extension from a filename if it has one.
 * @param name - A filename.
 * @return The filename without its extension.
 */
export function stripExt(name: string) {
  if (typeof process === 'undefined' || !process.versions?.node) return name;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const path = (process as any).getBuiltinModule(
    'node:path',
  ) as typeof import('node:path');
  const extension = path.extname(name);
  if (!extension) return name;
  return name.slice(0, -extension.length);
}

/**
 * Check if the given module is the main entry
 * @param module - `import.meta.url` for ESM or `module` for CommonJS
 * @returns
 */
export function isMain(module: string | object | ImportMeta) {
  if (typeof process === 'undefined' || !process.versions?.node) return false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _process = process as any;
  const path = _process.getBuiltinModule(
    'node:path',
  ) as typeof import('node:path');
  const nodeModule = _process.getBuiltinModule(
    'node:module',
  ) as typeof import('node:module');
  const {fileURLToPath} = _process.getBuiltinModule(
    'node:url',
  ) as typeof import('node:url');

  if (typeof module === 'object' && 'url' in module && 'main' in module) {
    // ESM environment
    return (module as ImportMeta).main;
  } else if (typeof module !== 'string') {
    // CJS Module object — require.main comparison
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (nodeModule as any).require?.main === module;
  } else {
    const require = nodeModule.createRequire(module);
    const scriptPath = require.resolve(process.argv[1]);
    const modulePath = fileURLToPath(module);
    const extension = path.extname(scriptPath);
    if (extension) {
      return modulePath === scriptPath;
    }
    return stripExt(modulePath) === scriptPath;
  }
}
