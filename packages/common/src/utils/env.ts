// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

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
function loadEnvFiles(): DotenvConfigOutput {
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

// Load .env files from monorepo root with cascading precedence
export const DOTENV_CONFIG = loadEnvFiles();

/**
 * Enumeration of environment types
 */
export enum EnvType {
  /**
   * Production
   */
  PROD = 'production',
  /**
   * Staging (preparing for production)
   */
  STAGING = 'staging',
  /**
   * QA - ready for QA
   */
  QA = 'qa',
  /**
   * Development mode
   */
  DEV = 'dev',
  /**
   * For tests
   */
  TEST = 'test',
}

/**
 * Get the environment full name (team + environment)
 */
export function getEnvName() {
  return getEnvVar('NODE_ENV');
}

/**
 * Get the environment type, default to `EnvType.QA`
 */
export function getEnv(name?: string): EnvType {
  const env = name ?? getEnvName();
  if (env == null) return EnvType.QA;
  const parts = env.split('-');
  const envType = parts.length === 0 ? parts[0] : parts[parts.length - 1];
  switch (envType) {
    case 'prod':
    case 'production':
      return EnvType.PROD;
    case 'staging':
      return EnvType.STAGING;
    case 'qa':
      return EnvType.QA;
    case 'test':
      return EnvType.TEST;
    case 'dev':
    case 'development':
      return EnvType.DEV;
    default:
      return EnvType.QA;
  }
}

/**
 * Set the environment name
 * @param env - Environment name
 */
export function setEnv(env: EnvType | string) {
  setEnvVar('NODE_ENV', env, true);
}

/**
 * Check if running in production mode
 */
export function isProduction(): boolean {
  return getEnv() === EnvType.PROD;
}

/**
 * Check if running in development mode
 * @returns
 */
export function isDevelopment() {
  return getEnv() === EnvType.DEV;
}

/**
 * Get the string value of an environment variable
 * @param name - Name of the variable
 * @param defaultValue - Default value
 * @returns
 */
export function getEnvVar(name: string, defaultValue: string): string;

/**
 * Get the string value of an environment variable
 * @param name - Name of the variable
 * @returns
 */
export function getEnvVar(name: string): string | undefined;

export function getEnvVar(
  name: string,
  defaultValue?: string,
): string | undefined {
  return process.env[name] ?? defaultValue;
}

/**
 * Get the number value of an environment variable
 * @param name - Name of the variable
 * @returns
 */
export function getEnvVarAsNumber(name: string): number | undefined;

/**
 * Get the number value of an environment variable
 * @param name - Name of the variable
 * @param defaultValue - Default value
 * @returns
 */
export function getEnvVarAsNumber(name: string, defaultValue: number): number;

export function getEnvVarAsNumber(
  name: string,
  defaultValue?: number,
): number | undefined {
  const val = getEnvVar(name);
  if (val == null) return defaultValue;
  const num = parseInt(val);
  if (isNaN(num)) {
    throw new Error(`The value of "${name}" is not a number: ${val}`);
  }
  return num;
}

/**
 * Get the environment variable as boolean
 * @param name - Variable name
 * @param defaultValue - Default value
 * @returns false if the lowercase string value is 'false`, '0', 'no', 'n', or ''
 */
export function getEnvVarAsBoolean(
  name: string,
  defaultValue = false,
): boolean {
  const val = getEnvVar(name);
  if (val == null) return defaultValue;
  return !['0', 'false', 'no', 'n', ''].includes(val.toLowerCase());
}

/**
 * Get the object value of an environment variable
 * @param name - Name of the variable
 * @returns
 */
export function getEnvVarAsObject<T>(name: string): T | undefined;

/**
 * Get the object value of an environment variable
 * @param name - Name of the variable
 * @param defaultValue - Default value
 * @returns
 */
export function getEnvVarAsObject<T>(name: string, defaultValue: T): T;

export function getEnvVarAsObject<T>(
  name: string,
  defaultValue?: T,
): T | undefined {
  const val = getEnvVar(name);
  if (val == null) return defaultValue;
  try {
    const obj = JSON.parse(val);
    return obj;
  } catch (err) {
    throw new Error(`The value of "${name}" is not an object: ${val}`);
  }
}

/**
 * Set an environment variable to the given value. It does not override existing
 * variables.
 * @param name - Name of the variable
 * @param value - Value that can be serialized as a string
 * @param override - Override existing variable
 * @returns
 */
export function setEnvVar(name: string, value: unknown, override = false) {
  if (process.env[name] != null && process.env[name] !== '' && !override) {
    // Do not override existing environment variable
    return process.env[name];
  }
  if (value == null) return value;

  if (typeof value === 'string') {
    // Set string value
    process.env[name] = value;
    return value;
  } else {
    // Set number/boolean/array/object values
    const str = JSON.stringify(value);
    process.env[name] = str;
    return str;
  }
}

/**
 * Delete an environment variable
 * @param name - Name of the variable
 */
export function unsetEnvVar(name: string) {
  delete process.env[name];
}

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
