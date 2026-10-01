// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomRequestStateKey, unavailableElicitor} from './elicit.js';
import {Binding} from '@agentback/context';
import {createBindingFromClass, type Component} from '@agentback/core';
import {MCPBindings, noopProgress} from './keys.js';
import {InMemoryConfirmationStore} from '@agentback/common';
import {DefaultMcpEventEmitter} from './events/emitter.js';
import {InMemorySubscriptionStore} from './events/in-memory-store.js';
import {MCPServer} from './mcp.server.js';

/**
 * `AGENTBACK_MCP_STATE_KEY` when set (one value shared by every instance),
 * else a random per-process key — fine for one process, refused by every
 * other instance behind a load balancer.
 */
function defaultRequestStateKey(): string {
  const env = (
    globalThis as {process?: {env?: Record<string, string | undefined>}}
  ).process?.env?.AGENTBACK_MCP_STATE_KEY;
  return env || randomRequestStateKey();
}

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
 * MCP Events gets the same treatment: {@link MCPBindings.SUBSCRIPTION_STORE}
 * (in-memory) and the {@link MCPBindings.EVENTS} emitter are app-level, since
 * `events/subscribe` and the emit that delivers to it are different requests.
 * The webhook delivery port is bound by `@agentback/mcp-events`.
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
    // Like PROGRESS: injection never fails; an ask outside an MCP request
    // throws elicitation_unavailable.
    Binding.bind(MCPBindings.ELICIT.key).to(unavailableElicitor),
    // App-level for the same reason as CONFIRMATION_STORE: state minted on one
    // request is verified on the next, and stateless serving builds a fresh
    // MCPServer per request.
    Binding.bind(MCPBindings.REQUEST_STATE_KEY.key).to(
      defaultRequestStateKey(),
    ),
    Binding.bind(MCPBindings.SUBSCRIPTION_STORE.key).to(
      new InMemorySubscriptionStore(),
    ),
    createBindingFromClass(DefaultMcpEventEmitter, {
      key: MCPBindings.EVENTS.key,
    }),
  ];
}
