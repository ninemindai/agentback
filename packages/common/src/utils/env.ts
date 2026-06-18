// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// NOTE: This file is intentionally free of Node-only imports (dotenv, node:fs,
// node:path, node:module) so that bundlers targeting browser / Cloudflare
// Workers can statically import this module without dragging in filesystem
// primitives.  The Node-only helpers (loadEnvFiles, DOTENV_CONFIG, stripExt,
// isMain) live in env-node.ts and are re-exported from utils/index.ts so the
// public API is unchanged for Node callers.

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
