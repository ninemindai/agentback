// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {AuthInfo, McpRequestContext} from '@modelcontextprotocol/server';
import {BindingScope, Context} from '@agentback/core';
import {MCPBindings, MCPServer} from '@agentback/mcp';

/**
 * Populate a per-session DI context before its `MCPServer` is resolved. Bind
 * any user-specific `@mcpServer` tool classes (via `addTool(sessionCtx,
 * ToolClass)`) so they are discovered only for this session/user. May be async
 * (e.g. an entitlement lookup).
 *
 * `request` is a **Web `Request` on every host** — the Express host converts
 * its `IncomingMessage` before calling you, so one binder works everywhere.
 * Read headers with `request.headers.get(name)`.
 *
 * The authenticated principal is **not** on the request: read it from the
 * context you are handed, which is the framework's existing idiom and the only
 * spoof-proof source.
 *
 * ```ts
 * async perSession(ctx) {
 *   const auth = await ctx.get(MCPBindings.REQUEST_AUTH, {optional: true});
 *   if (!auth) return;                       // anonymous -> shared tools only
 *   for (const T of entitlements.toolsFor(auth.clientId)) addTool(ctx, T);
 * }
 * ```
 *
 * Mutate **only** `sessionCtx`; never reach up to the application context.
 */
export type SessionBinder = (
  sessionCtx: Context,
  request: Request,
) => void | Promise<void>;

/**
 * Build the per-session DI context and resolve its own `MCPServer`.
 *
 * Shared by the Express and fetch hosts so the two cannot drift: before this
 * existed each mount had its own copy, and they disagreed about what the binder
 * receives — the Express host passed an Express `req` while the fetch host
 * passed a Web `Request` behind a cast, so a binder written to the documented
 * signature broke on the edge host.
 *
 * The caller owns the returned context's lifetime: `close()` it when the
 * session ends, and on any throw from here (the binder, schema lowering) the
 * context is closed before rethrowing, since no transport is connected yet.
 */
export async function resolveSessionServer(options: {
  appContext: Context;
  binder: SessionBinder;
  request: Request;
  authInfo?: AuthInfo;
}): Promise<{sessionCtx: Context; mcp: MCPServer}> {
  // Parent on the app context; a SINGLETON binding OWNED by sessionCtx resolves
  // against sessionCtx, so `@inject.context()` hands the new server THIS
  // context — its tool discovery then walks sessionCtx -> app (app config still
  // resolves up the chain), giving one server per session.
  const sessionCtx = new Context(options.appContext, 'mcp.session');
  try {
    // The validated principal, bound under the same key tools inject, so the
    // binder reads identity the one spoof-proof way instead of digging through
    // a host-specific request object.
    if (options.authInfo) {
      sessionCtx.bind(MCPBindings.REQUEST_AUTH).to(options.authInfo);
    }
    await options.binder(sessionCtx, options.request);
    sessionCtx
      .bind(MCPBindings.SERVER.key)
      .toClass(MCPServer)
      .inScope(BindingScope.SINGLETON);
    return {sessionCtx, mcp: await sessionCtx.get(MCPBindings.SERVER)};
  } catch (err) {
    sessionCtx.close();
    throw err;
  }
}

/**
 * Build the `McpServerFactory` that stateless serving hands to
 * `createMcpHandler` — one server per HTTP request, scope-gated by the
 * principal the caller already verified.
 *
 * When a binder is configured, each request also gets its own DI child context
 * (per-request tool discovery, the stateless successor to per-session
 * discovery). **Disposal rides the SDK's own lifetime signal:** it closes the
 * per-request server when the exchange completes — after any streamed progress,
 * and before the response body finishes draining — so `onclose` is the correct
 * point to release the context. Closing when `fetch()` resolves would be far too
 * early: `fetch()` returns before the tool has done any work.
 *
 * The existing handler is chained rather than replaced, so this never clobbers
 * teardown the SDK installed itself.
 */
export function perRequestFactory(options: {
  mcp: MCPServer;
  binder?: SessionBinder;
  appContext?: Context;
}) {
  return async (ctx: McpRequestContext) => {
    const scoped = ctx.authInfo ? {scopes: ctx.authInfo.scopes ?? []} : {};
    if (!options.binder || !ctx.requestInfo) {
      return options.mcp.buildServer(scoped);
    }
    const {sessionCtx, mcp} = await resolveSessionServer({
      appContext: options.appContext!,
      binder: options.binder,
      request: ctx.requestInfo,
      ...(ctx.authInfo ? {authInfo: ctx.authInfo} : {}),
    });
    const server = mcp.buildServer(scoped);
    const previous = server.server.onclose;
    server.server.onclose = () => {
      previous?.();
      sessionCtx.close();
    };
    return server;
  };
}
