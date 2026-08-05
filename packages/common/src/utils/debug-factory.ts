// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import debug, {Debugger, log} from 'debug';
import {InspectOptions} from 'util';
import {LogLevel, isDebugEnabled, isLogEnabled, redactData} from './debug.js';
import {getEnvVarAsNumber} from './env.js';

/**
 * Debug namespaces
 */
export const debugNamespaces: Set<string> = new Set();

/**
 * Callback signature for log hooks.
 * @param namespace - Full debug namespace (e.g. "loopback:rest:error")
 * @param level - Log level extracted from the namespace suffix
 * @param args - The log arguments (already redacted)
 */
export type LogHook = (
  namespace: string,
  level: LogLevel,
  args: unknown[],
) => void | Promise<void>;

const logHooks: LogHook[] = [];

/**
 * Register a hook that is called on every warn/error log event.
 * Hooks may be sync or async — async hooks are fire-and-forget.
 * Returns a dispose function to unregister the hook.
 */
export function onLog(hook: LogHook): () => void {
  logHooks.push(hook);
  return () => {
    const idx = logHooks.indexOf(hook);
    if (idx >= 0) logHooks.splice(idx, 1);
  };
}

let notifying = false;

function notifyHooks(namespace: string, args: unknown[]) {
  if (logHooks.length === 0) return;
  // Guard against recursion: if a hook implementation uses loggers
  // (e.g., warn/error), skip hook notification to prevent infinite loops.
  if (notifying) return;
  // Extract level from namespace suffix (e.g. "loopback:rest:error" → "error")
  const lastColon = namespace.lastIndexOf(':');
  const suffix = lastColon >= 0 ? namespace.slice(lastColon + 1) : '';
  const level = Object.values(LogLevel).includes(suffix as LogLevel)
    ? (suffix as LogLevel)
    : undefined;
  if (!level) return;
  // Only fire hooks for warn and error
  if (level !== LogLevel.ERROR && level !== LogLevel.WARN) return;
  notifying = true;
  try {
    for (const hook of logHooks) {
      try {
        const result = hook(namespace, level, args);
        // Swallow async rejections — hooks must never break logging
        if (result && typeof result.catch === 'function') {
          result.catch(() => {});
        }
      } catch {
        // Never let a hook break logging
      }
    }
  } finally {
    notifying = false;
  }
}

/**
 * Notify every registered `onLog` hook for one warn/error record, regardless
 * of whether `debugger_`'s `DEBUG` namespace is enabled.
 *
 * The raw `debug` package gates the whole call ahead of `fn.log` — see
 * `createDebug` in `debug/src/common.js`, `if (!debug.enabled) return;` — so
 * when a namespace nobody enabled logs a line, `fn.log` (and the `onLog`
 * notification inside it) never runs at all. That silently breaks the
 * contract `onLog`'s own doc promises ("fired on every warn/error log"): a
 * hook registered to ship events to an external system misses every line
 * logged under a namespace that is off, which for most namespaces most of the
 * time is all of them.
 *
 * Call this for a record that must reach a registered sink unconditionally —
 * still call the plain `debugger_(...)` too, so console output stays exactly
 * as gated as it always was. Safe to call either way: when the namespace
 * *is* enabled, `fn.log` already notified hooks once via the normal path, so
 * this is a deliberate no-op rather than a second delivery of the same event.
 */
export function notifyLogHooksAlways(
  debugger_: Debugger,
  args: unknown[],
): void {
  if (isLogEnabled(debugger_.namespace)) return; // already notified by fn.log
  notifyHooks(debugger_.namespace, redactData(args));
}

/**
 * Create a debug instance for the given namespace
 * @param namespace - Namespace
 */
export function debugFactory(namespace: string): Debugger {
  debugNamespaces.add(namespace);

  const fn = debug(namespace);

  // Add log reaction
  const defaultLog = fn.log ?? log;
  fn.log = (...args) => {
    if (!isLogEnabled(namespace)) return;
    const redacted = redactData(args);
    notifyHooks(namespace, redacted);
    return defaultLog(...redacted);
  };
  // Set depth for object dump
  const depth = getEnvVarAsNumber('DEBUG_DEPTH', 10);
  const options = fn as unknown as {inspectOpts: InspectOptions};
  options.inspectOpts = options.inspectOpts ?? {};
  options.inspectOpts.depth = depth;
  return fn;
}

/**
 * Loggers for the given namespace
 * @param namespace - Namespace for logging
 * @returns
 */
export function loggers(namespace: string): Record<LogLevel, Debugger> {
  return {
    [LogLevel.ERROR]: debugFactory(`${namespace}:${LogLevel.ERROR}`),
    [LogLevel.WARN]: debugFactory(`${namespace}:${LogLevel.WARN}`),
    [LogLevel.INFO]: debugFactory(`${namespace}:${LogLevel.INFO}`),
    [LogLevel.DEBUG]: debugFactory(`${namespace}:${LogLevel.DEBUG}`),
    [LogLevel.TRACE]: debugFactory(`${namespace}:${LogLevel.TRACE}`),
  };
}

/**
 * Alias for loggers
 */
export const debuggers = loggers;

/**
 * Get an object of debug settings
 */
export function getDebugSettings() {
  const settings: Record<string, boolean> = {};
  for (const ns of debugNamespaces) {
    settings[ns] = isDebugEnabled(ns);
  }
  return settings;
}
