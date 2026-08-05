// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * `onLog` hooks sit behind the `debug` package's own enabled-gate: the raw
 * `debug()` call short-circuits before `fn.log` ever runs when nobody
 * enabled the namespace, so a hook registered to ship warn/error events to an
 * external system silently misses everything logged under a namespace that
 * is off — which, for most namespaces most of the time, is all of them.
 * `notifyLogHooksAlways` is the escape hatch: it bypasses that gate for a
 * caller that needs guaranteed delivery, without changing what the console
 * itself prints.
 */

import {describe, expect, it} from 'vitest';
import {
  debugFactory,
  notifyLogHooksAlways,
  onLog,
} from '../../utils/debug-factory.js';
import {enableDebug, LogLevel} from '../../utils/debug.js';

describe('notifyLogHooksAlways', () => {
  it('notifies a registered onLog hook even when the namespace is not enabled', () => {
    const previous = process.env.DEBUG ?? '';
    enableDebug(''); // explicitly nothing enabled
    const warn = debugFactory('agentback:test:hooks:warn');
    expect(warn.enabled).toBe(false);

    const seen: {namespace: string; level: LogLevel; args: unknown[]}[] = [];
    const dispose = onLog((namespace, level, args) => {
      seen.push({namespace, level, args});
    });
    try {
      notifyLogHooksAlways(warn, ['boom %s', 'detail']);
    } finally {
      dispose();
      enableDebug(previous);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      namespace: 'agentback:test:hooks:warn',
      level: LogLevel.WARN,
      args: ['boom %s', 'detail'],
    });
  });

  it('does not double-notify when the namespace is already enabled', () => {
    const previous = process.env.DEBUG ?? '';
    enableDebug('agentback:test:hooks:*');
    const warn = debugFactory('agentback:test:hooks:warn');
    expect(warn.enabled).toBe(true);

    const seen: unknown[] = [];
    const dispose = onLog((_namespace, _level, args) => {
      seen.push(args);
    });
    try {
      // The normal path: calling the debugger itself notifies hooks once.
      warn('boom %s', 'detail');
      // The explicit call must be a no-op here — the namespace is enabled,
      // so `fn.log` already delivered this event.
      notifyLogHooksAlways(warn, ['boom %s', 'detail']);
    } finally {
      dispose();
      enableDebug(previous);
    }

    expect(seen).toHaveLength(1);
  });

  it('is a no-op for a namespace whose level is not warn/error', () => {
    const previous = process.env.DEBUG ?? '';
    enableDebug('');
    const info = debugFactory('agentback:test:hooks:info');

    const seen: unknown[] = [];
    const dispose = onLog((_namespace, _level, args) => {
      seen.push(args);
    });
    try {
      notifyLogHooksAlways(info, ['ignored']);
    } finally {
      dispose();
      enableDebug(previous);
    }

    expect(seen).toHaveLength(0);
  });
});
