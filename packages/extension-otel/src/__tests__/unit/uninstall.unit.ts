// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * installOtel returns an Installed (docs/proposals/revertible-installs.md,
 * wave 5): bindings-only on an MCP-only app — the three hook/provider
 * bindings are unbound. (The REST middleware, when mounted, is gated; its
 * spans are invisible without an SDK, so the binding check is the assertion.)
 */

import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import {MeteringBindings} from '@agentback/metering';
import {installOtel} from '../../install.js';
import {
  OTEL_MCP_DISPATCH_HOOK_KEY,
  OTEL_REST_DISPATCH_HOOK_KEY,
} from '../../dispatch-hooks.js';

describe('installOtel uninstall', () => {
  it('unbinds the dispatch hooks and the trace-id provider', async () => {
    const app = new Application();
    const installed = await installOtel(app);

    expect(app.isBound(OTEL_REST_DISPATCH_HOOK_KEY)).toBe(true);
    expect(app.isBound(OTEL_MCP_DISPATCH_HOOK_KEY)).toBe(true);
    expect(app.isBound(MeteringBindings.TRACE_ID_PROVIDER.key)).toBe(true);

    await installed.uninstall();

    expect(app.isBound(OTEL_REST_DISPATCH_HOOK_KEY)).toBe(false);
    expect(app.isBound(OTEL_MCP_DISPATCH_HOOK_KEY)).toBe(false);
    expect(app.isBound(MeteringBindings.TRACE_ID_PROVIDER.key)).toBe(false);
    await expect(installed.uninstall()).resolves.toBeUndefined();
  });
});
