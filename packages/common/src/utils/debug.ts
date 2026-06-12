// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import debug from 'debug';
import util from 'node:util';
import {getEnvVar, setEnvVar} from './env.js';

export {Debugger} from 'debug';

export const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

export enum LogLevel {
  ERROR = 'error',
  WARN = 'warn',
  INFO = 'info',
  DEBUG = 'debug',
  TRACE = 'trace',
}

/**
 * Check if the namespace is enabled by log level
 * @param namespace - Debug namespace
 * @returns
 */
export function isLogEnabled(namespace: string) {
  if (!isDebugEnabled(namespace)) return false;
  const levels = Object.values(LogLevel);
  const enabledLevel = getLogLevelForNamespace(namespace);
  const logLevel = getLogLevel();
  const index = levels.indexOf(logLevel);
  return levels.indexOf(enabledLevel) <= index;
}

export function setLogLevel(level: LogLevel) {
  return setEnvVar('LOG_LEVEL', level, true);
}

export function getLogLevel() {
  const logLevelSetting = getEnvVar(
    'LOG_LEVEL', // First check for LOG_LEVEL
    getEnvVar('DEBUG_PINO', LogLevel.TRACE), // Then check for DEBUG_PINO
  );
  const levels = Object.values(LogLevel);
  const logLevel =
    levels.find(level => level === logLevelSetting.toLowerCase()) ??
    LogLevel.TRACE;
  return logLevel;
}

/**
 * Get the highest log level for the given namespace
 * @param namespace - Debug namespace
 * @returns
 */
export function getLogLevelForNamespace(namespace: string) {
  namespace = namespace.toLowerCase();
  const levels = Object.values(LogLevel);
  const names = namespace.split(':');
  const enabledLevels = levels.filter(level => names.includes(level));
  if (enabledLevels.length === 0) {
    // Default to debug
    return LogLevel.DEBUG;
  }
  // Return the last level matched
  return enabledLevels[enabledLevels.length - 1];
}

/**
 * React arguments to hide secrets
 * @param args - Args
 * @returns
 */
export function redactData<T = unknown>(
  args: T,
  secretKeys: string[] = [
    'KEY',
    'PASSWORD',
    'SECRET',
    'PRIVATE',
    'PASS',
    'TOKEN',
    'SEED',
  ],
): T {
  // Deep-clone plain objects/arrays, masking any value whose property key
  // contains a secret marker. Non-plain objects (Date, Error, Map, class
  // instances, …) are passed through by reference — redaction keys off
  // property names, and we never mutate the input. Cycle-safe via `seen`.
  const seen = new WeakMap<object, unknown>();
  const isSecret = (key: string) => secretKeys.some(k => key.includes(k));

  const clone = (value: unknown, key: string | number | undefined): unknown => {
    if (typeof key === 'string' && isSecret(key)) return '******';
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);

    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      seen.set(value, arr);
      value.forEach((el, i) => (arr[i] = clone(el, i)));
      return arr;
    }
    // Only recurse into plain objects; pass other object types through.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const k of Object.keys(value)) {
      out[k] = clone((value as Record<string, unknown>)[k], k);
    }
    return out;
  };

  return clone(args, undefined) as T;
}

/**
 * Mask a secret while preserving a tiny non-sensitive fingerprint.
 * Example: `abcd...yz (len=32)`.
 */
export function maskSecret(
  value: string | null | undefined,
  visiblePrefix = 4,
  visibleSuffix = 2,
): string {
  if (!value) return '<empty>';
  if (value.length <= visiblePrefix + visibleSuffix) {
    return '*'.repeat(value.length);
  }
  return `${value.slice(0, visiblePrefix)}...${value.slice(
    -visibleSuffix,
  )} (len=${value.length})`;
}

/**
 * Enable debug for the given namespaces
 * @param namespaces - Namespace list
 */
export function enableDebug(namespaces: string) {
  debug.enable(namespaces);
}

/**
 * Check if a debug namespace is enabled
 * @param namespace - Debug namespace
 */
export function isDebugEnabled(namespace: string) {
  return debug.enabled(namespace);
}

/**
 * Set debug flags
 * @param settings - Debug settings
 */
export function setDebugSettings(settings: Record<string, boolean>) {
  const list: string[] = [];
  for (const ns in settings) {
    if (settings[ns]) {
      list.push(ns);
    } else {
      // Disable with `-<ns>`
      list.push(`-${ns}`);
    }
  }
  enableDebug(list.join(','));
}

/**
 * Use `util.inspect` to print out the value
 * @param value - Value
 * @param depth - Depth, default to 8
 * @returns
 */
export function print(value: unknown, depth = 8) {
  return util.inspect(value, {depth, colors: false, showHidden: false});
}

/**
 * Stringify the value with 2-space indentation
 * @param value - Value
 * @returns
 */
export function stringify(value: unknown) {
  return JSON.stringify(value, null, 2);
}
