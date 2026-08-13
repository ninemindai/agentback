// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {Application} from '@agentback/core';
import type {PaymentRail} from '../../types.js';
import {
  installPriceGate,
  PRICE_GATE_MCP_HOOK_KEY,
  PRICE_GATE_REST_HOOK_KEY,
} from '../../price-gate.js';

const fakeRail = {} as PaymentRail;

describe('installPriceGate uninstall', () => {
  it('unbinds both dispatch-hook bindings', async () => {
    const app = new Application();
    const installed = installPriceGate(app, {rail: fakeRail});

    expect(app.isBound(PRICE_GATE_REST_HOOK_KEY)).toBe(true);
    expect(app.isBound(PRICE_GATE_MCP_HOOK_KEY)).toBe(true);

    await installed.uninstall();

    expect(app.isBound(PRICE_GATE_REST_HOOK_KEY)).toBe(false);
    expect(app.isBound(PRICE_GATE_MCP_HOOK_KEY)).toBe(false);
    await expect(installed.uninstall()).resolves.toBeUndefined();
  });
});
