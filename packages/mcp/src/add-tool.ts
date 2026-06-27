// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  type Binding,
  type Constructor,
  type Context,
  createServiceBinding,
} from '@agentback/core';

/**
 * Register a `@mcpServer` tool class into a {@link Context}, the same way
 * `app.service(C)` registers it on an application.
 *
 * This is the session-scoped counterpart to `app.service(...)`: use it inside a
 * per-session binder (see `@agentback/mcp-http`'s `perSession`) to contribute a
 * tool/resource/prompt class that the session's `MCPServer` discovers — and that
 * no other session sees. It routes through `createServiceBinding`, so the
 * binding carries the class's `@mcpServer` extension tag **and** the same
 * `service` tags an app-level registration gets, keeping session-local tools
 * indistinguishable from app-level ones to the DI/schema explorers.
 *
 * @param ctx - The context to register the tool class into (e.g. a per-session
 *   child context). The class is discovered via the chain walk, so it is visible
 *   to any `MCPServer` whose context is `ctx` or a descendant.
 * @param toolClass - A class decorated with `@mcpServer()`.
 * @returns The created binding (already added to `ctx`).
 */
export function addTool(
  ctx: Context,
  toolClass: Constructor<unknown>,
): Binding {
  const binding = createServiceBinding(toolClass);
  ctx.add(binding);
  return binding;
}
