// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding} from '@agentback/context';
import type {Component} from '@agentback/core';
import {MCPBindings, noopProgress} from './keys.js';
import {InMemoryConfirmationStore} from '@agentback/common';
import {MCPServer} from './mcp.server.js';

/**
 * Component that contributes MCPServer to an Application.
 *
 * Also binds the app-level default for {@link MCPBindings.PROGRESS} (a no-op):
 * entry paths without SDK request extras — direct `callTool`, the inspector —
 * still resolve a `ProgressFn`, so tools injecting it never hit a
 * `ResolutionError`. Transport-driven calls shadow this default with a live
 * relay in the per-request context. The component (not the `MCPServer`
 * constructor) is the seam because it is the declarative place for app-level
 * contributions, and a later `app.bind(MCPBindings.PROGRESS)` cleanly
 * overrides it. Note: `MCPBindings.REQUEST_EXTRA` deliberately has NO
 * app-level default — inject it with `{optional: true}`.
 *
 * Also binds the app-level default {@link MCPBindings.CONFIRMATION_STORE}.
 * This is app-scoped ON PURPOSE: `confirm:` issues a token in one request and
 * verifies it in the next, and under `protocol: 'both'` (the default) a
 * `perSession` binder builds a FRESH `MCPServer` per request. An
 * instance-level fallback store therefore vanished between the two calls and
 * every confirmation failed as `confirmation_invalid` — the dangerous tool
 * could never be run. Binding it here means every per-request child resolves
 * the same instance by walking the context chain. Still in-memory, so a
 * multi-instance deployment must override it with a shared store.
 *
 * @example
 *   const app = new RestApplication();
 *   app.component(MCPComponent);
 *   app.service(EchoTools);  // class decorated with @mcpServer()
 *   await app.start();
 */
export class MCPComponent implements Component {
  servers = {MCPServer};
  bindings = [
    Binding.bind(MCPBindings.PROGRESS.key).to(noopProgress),
    Binding.bind(MCPBindings.CONFIRMATION_STORE.key).to(
      new InMemoryConfirmationStore(),
    ),
  ];
}
