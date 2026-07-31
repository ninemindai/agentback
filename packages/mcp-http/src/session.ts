// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createMcpHandler} from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  McpHttpHandler,
  McpRequestContext,
} from '@modelcontextprotocol/server';
import {BindingScope, Context} from '@agentback/core';
import {loggers} from '@agentback/common';
import {MCPBindings, MCPServer} from '@agentback/mcp';
import type {McpHttpOptions} from './index.js';

const log = loggers('agentback:mcp-http:session');

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
 *   // NOT `auth.clientId` — under OAuth that is the client APPLICATION id,
 *   // shared by every end user of that app. Use your IdP's subject claim.
 *   for (const T of entitlements.toolsFor(auth.extra?.sub)) addTool(ctx, T);
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

/**
 * Normalize configured `Host` / `Origin` allowlist entries to bare hostnames.
 *
 * The two APIs disagree, and forwarding one to the other fails closed but
 * silently. `McpHttpOptions.allowedOrigins` is documented as *Origin header
 * values* (`https://app.example.com`) because that is what the SDK's
 * transport option took. The SDK's standalone validators instead parse the
 * INCOMING header down to a hostname and compare against a list of
 * **hostnames** — so handing them `https://app.example.com` compares
 * `app.example.com` against `['https://app.example.com']`, never matches, and
 * rejects every request.
 *
 * Accepts either form so a user's existing config keeps working:
 * `https://app.example.com`, `mcp.example.com:8080` and `mcp.example.com` all
 * normalize to their hostname. Unparseable entries pass through untouched
 * rather than being dropped — an entry that never matches is safer than one
 * silently removed from an allowlist.
 */
export function toHostnames(values: string[]): string[] {
  return values.map(value => {
    // Already a URL (has a scheme) — take its hostname.
    try {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        return new URL(value).hostname;
    } catch {
      return value;
    }
    // Bare host, possibly with a port.
    try {
      return new URL(`http://${value}`).hostname;
    } catch {
      return value;
    }
  });
}

/**
 * Merge `Mcp-Session-Id` into an `Access-Control-Expose-Headers` value.
 *
 * Under CORS a browser can only READ a response header that is named here, and
 * the session id is the one header the MCP session protocol requires a client
 * to read and echo back. Without it a cross-origin browser client completes
 * `initialize`, cannot see the minted id, sends nothing on the next request,
 * and is answered "no active MCP session" — a failure that looks like a
 * server bug and never mentions CORS. `curl` is unaffected, so this reproduces
 * only in a browser.
 *
 * This is **not** an access grant: whether an origin may read the response at
 * all is decided by `Access-Control-Allow-Origin`, which stays entirely
 * governed by the app's `rest.cors` config. With no `cors` configured there is
 * no allow-origin and this header is inert. So it is safe to always send on the
 * session path, and pointless on the stateless one (no session is ever minted).
 *
 * Any value the app's own CORS config already set is preserved — an app that
 * exposes its own headers must not lose them to this.
 */
export function withSessionIdExposed(existing?: string | null): string {
  const names = (existing ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (names.some(n => n.toLowerCase() === 'mcp-session-id')) {
    return names.join(', ');
  }
  return [...names, 'Mcp-Session-Id'].join(', ');
}

/** Everything the two hosts share when `protocol: 'both'` is enabled. */
export interface StatelessSetup {
  /** Whether stateless serving is on. */
  enabled: boolean;
  /** The handler serving both protocol eras. Present only when enabled. */
  handler?: McpHttpHandler;
  /**
   * DNS-rebinding allowlists, already normalized to the hostnames the SDK's
   * validators compare against. Each host applies these in its own idiom
   * (Express middleware vs fetch `Response` builders), which is the one part
   * that genuinely differs and so is deliberately NOT shared.
   */
  allowedHostnames?: string[];
  allowedOriginHostnames?: string[];
}

/**
 * Build the stateless serving setup both hosts need.
 *
 * Extracted because the two mounts previously kept their own copies of this —
 * the same shape that let `SessionBinder` drift and hand one host the wrong
 * request type. Consolidating means an option added here cannot be wired on one
 * host and forgotten on the other.
 */
export function setupStateless(
  mcp: MCPServer,
  options: McpHttpOptions,
): StatelessSetup {
  const enabled = options.protocol === 'both';
  if (!enabled) return {enabled: false};

  if (options.eventStore) {
    log.warn(
      "protocol: 'both' ignores `eventStore` — resumable SSE replay is a " +
        'session feature and the stateless era has no sessions.',
    );
  }
  // On by default whenever either allowlist is configured, matching the
  // session path's behaviour.
  const rebinding =
    options.enableDnsRebindingProtection ??
    (options.allowedHosts != null || options.allowedOrigins != null);

  return {
    enabled: true,
    handler: createMcpHandler(
      perRequestFactory({
        mcp,
        ...(options.perSession ? {binder: options.perSession} : {}),
        ...(options.appContext ? {appContext: options.appContext} : {}),
      }),
      {
        // Without this, a throwing factory — which is where the perSession
        // binder runs — answers 500 with nothing logged, so an entitlement
        // outage presents as an unexplained error from our server.
        onerror: (error: Error) =>
          log.error('stateless request failed: %s', error.stack ?? error),
      },
    ),
    ...(rebinding && options.allowedHosts
      ? {allowedHostnames: toHostnames(options.allowedHosts)}
      : {}),
    ...(rebinding && options.allowedOrigins
      ? {allowedOriginHostnames: toHostnames(options.allowedOrigins)}
      : {}),
  };
}
