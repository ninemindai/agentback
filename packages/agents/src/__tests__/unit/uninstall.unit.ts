// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * installAgent returns an Installed (docs/proposals/revertible-installs.md,
 * wave 4): uninstall() destroys live sessions, unbinds the three agent
 * bindings, and deregisters the onStop hook. No routes — bindings-only.
 */

import {describe, expect, it, vi} from 'vitest';
import {Application} from '@agentback/core';
import {AgentBindings} from '../../keys.js';
import {installAgent} from '../../install.js';
import type {AgentSessionRegistry} from '../../session-registry.js';
import type {AgentPort} from '../../port.js';

const fakeAgent: AgentPort = {generate: async () => ({text: 'ok'})};

describe('installAgent uninstall', () => {
  it('destroys live sessions and unbinds the agent bindings', async () => {
    const app = new Application();
    const installed = installAgent(app, {agent: fakeAgent});

    const registry = await app.get<AgentSessionRegistry>(
      AgentBindings.SESSIONS.key,
    );
    const destroy = vi.fn(async () => {});
    registry.register({destroy});

    await installed.uninstall();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(app.isBound(AgentBindings.SESSIONS.key)).toBe(false);
    expect(app.isBound(AgentBindings.RAW_AGENT.key)).toBe(false);
    expect(app.isBound(AgentBindings.AGENT.key)).toBe(false);
  });

  it('uninstall is idempotent and stop() after uninstall is clean', async () => {
    const app = new Application();
    const installed = installAgent(app, {agent: fakeAgent});
    await app.start();

    await installed.uninstall();
    await expect(installed.uninstall()).resolves.toBeUndefined();
    await expect(app.stop()).resolves.toBeUndefined();
  });

  it('uninstall leaves a binding the user has since shadowed over ours', async () => {
    // bind() REPLACES at the same key: after install, the user rebinds
    // AGENT to their own value. Uninstall must NOT remove the user's
    // binding — an inverse only retracts what it owns (identity-guarded
    // unbind, outside-voice finding C4 on PR #51).
    const app = new Application();
    const installed = installAgent(app, {agent: fakeAgent});

    const mine = {generate: async () => ({text: 'user-owned'})};
    app.bind(AgentBindings.AGENT.key).to(mine);

    await installed.uninstall();

    // Our other bindings are gone, but the user's shadow survives.
    expect(app.isBound(AgentBindings.SESSIONS.key)).toBe(false);
    expect(app.isBound(AgentBindings.AGENT.key)).toBe(true);
    expect(await app.get(AgentBindings.AGENT.key)).toBe(mine);
  });
});
