// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import type {AuthInfo} from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  fromWebRequest,
  normalizeAuthResult,
  resolveStrategy,
  type AuthenticationResult,
} from '@agentback/authentication';
import {securityId} from '@agentback/security';
import {BindingScope, Context} from '@agentback/core';
import {MCPBindings, MCPServer} from '@agentback/mcp';
import {loggers} from '@agentback/common';
import type {RestServer} from '@agentback/rest';
import type {McpHttpOptions, McpHttpHandle} from './index.js';

const log = loggers('agentback:mcp-http:fetch');

const DEFAULT_PATH = '/mcp';

/** JSON-RPC error as a Web Response. */
function rpcError(status: number, message: string): Response {
  return Response.json(
    {jsonrpc: '2.0', error: {code: -32000, message}, id: null},
    {status},
  );
}

/**
 * Resolve `@agentback/authentication` strategies against a Web `Request` and
 * return an MCP {@link AuthInfo}, mirroring the Express `frameworkAuthGuard` but
 * for the runtime-neutral fetch path (uses `fromWebRequest`, not the Express
 * adapter). Returns `undefined` when no strategy authenticates.
 */
async function resolveStrategyAuthInfo(
  req: Request,
  strategy: string | string[],
  context: Context,
  toScopes?: (auth: AuthenticationResult) => string[],
): Promise<AuthInfo | undefined> {
  const names = Array.isArray(strategy) ? strategy : [strategy];
  const authReq = fromWebRequest(req);
  let result: AuthenticationResult | undefined;
  for (const name of names) {
    const s = await resolveStrategy(context, name);
    if (!s) continue;
    try {
      const norm = normalizeAuthResult(await s.authenticate(authReq));
      if (norm.user || norm.clientApplication) {
        result = norm;
        break;
      }
    } catch {
      // Try the next strategy.
    }
  }
  if (!result) return undefined;

  const principal = result.user ?? result.clientApplication;
  const scopes = toScopes
    ? toScopes(result)
    : defaultScopes(result);
  return {
    token: 'framework',
    clientId: principal ? principal[securityId] : 'unknown',
    scopes,
    extra: {user: result.user, clientApplication: result.clientApplication},
  };
}

/** Derive MCP scopes from the authenticated principal (mirrors framework-auth). */
function defaultScopes(auth: AuthenticationResult): string[] {
  const principal = (auth.user ?? auth.clientApplication) as
    | {scopes?: string[] | string}
    | undefined;
  const raw = principal?.scopes ?? auth.clientApplication?.allowedScopes;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return raw.split(' ').filter(Boolean);
  return [];
}

/**
 * Mount the MCP Streamable HTTP transport on a {@link RestServer}'s
 * runtime-neutral fetch surface (`addFetchHandler`), using the SDK's
 * {@link WebStandardStreamableHTTPServerTransport}
 * (`handleRequest(Request): Promise<Response>`). This is the host-agnostic
 * counterpart of `mountMcpHttp` (Express) — it makes MCP-over-HTTP work under
 * `rest.listener: 'native'` and on Bun/Fastify/Hono, where there is no Express
 * `req`/`res`.
 *
 * Each session gets its own SDK server + transport, keyed by `Mcp-Session-Id`,
 * with the same per-principal session pinning and `perSession` DI-context
 * support as the Express mount. `strategyAuth` is honored via the neutral
 * {@link fromWebRequest} seam; OAuth resource-server bearer auth
 * (`options.auth`) is **not** wired on the fetch path yet (the SDK's
 * `requireBearerAuth` is Express middleware) — use the Express host for that, or
 * gate with `strategyAuth`.
 */
export function mountMcpHttpFetch(
  mcp: MCPServer,
  server: RestServer,
  options: McpHttpOptions = {},
): McpHttpHandle {
  const path = options.path ?? DEFAULT_PATH;
  const transports: Record<string, WebStandardStreamableHTTPServerTransport> =
    {};
  const sessionOwners: Record<string, string | undefined> = {};
  const sessionContexts: Record<string, Context | undefined> = {};
  const perSession = options.perSession;
  const strategyAuth = options.strategyAuth;
  const authEnabled = Boolean(strategyAuth);

  if (options.auth) {
    log.warn(
      'options.auth (OAuth resource-server bearer) is not supported on the ' +
        'fetch path; requests are NOT bearer-gated here. Use the Express host ' +
        'for OAuth bearer auth, or use strategyAuth.',
    );
  }
  if (perSession && !options.appContext) {
    throw new Error(
      '@agentback/mcp-http: options.appContext is required when `perSession` ' +
        'is set.',
    );
  }
  if (strategyAuth && !strategyAuth.context) {
    throw new Error(
      '@agentback/mcp-http: strategyAuth.context is required (installMcpHttp ' +
        'sets it automatically).',
    );
  }

  // A request may only touch a session owned by its own principal (defense in
  // depth: the id is a random UUID, but must never serve another tenant).
  const ownsSession = (id: string, principal: string | undefined): boolean =>
    !authEnabled ||
    sessionOwners[id] === undefined ||
    sessionOwners[id] === principal;

  const handle = async (req: Request): Promise<Response> => {
    // Authenticate once per request (when strategyAuth is configured).
    let authInfo: AuthInfo | undefined;
    if (strategyAuth) {
      authInfo = await resolveStrategyAuthInfo(
        req,
        strategyAuth.strategy,
        strategyAuth.context!,
        strategyAuth.scopes,
      );
      if (!authInfo && (strategyAuth.required ?? true)) {
        return rpcError(401, 'Unauthorized');
      }
    }
    const principal = authInfo?.clientId;

    const sessionId = req.headers.get('mcp-session-id') ?? undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (transport && sessionId && !ownsSession(sessionId, principal)) {
      return rpcError(403, 'MCP session belongs to a different principal');
    }

    // POST may carry a body; read it once and hand it to the SDK as parsedBody
    // (a Web Request body is single-read). GET/DELETE carry none.
    let parsedBody: unknown;
    if (req.method === 'POST') {
      try {
        parsedBody = await req.json();
      } catch {
        parsedBody = undefined;
      }
    }

    if (!transport) {
      if (sessionId) {
        return rpcError(404, `Unknown MCP session: ${sessionId}`);
      }
      if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
        return rpcError(
          400,
          'No active MCP session and request is not an initialize request',
        );
      }
      let sessionCtx: Context | undefined;
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        ...(options.eventStore ? {eventStore: options.eventStore} : {}),
        onsessioninitialized: id => {
          transports[id] = transport!;
          if (authEnabled) sessionOwners[id] = principal;
          if (sessionCtx) sessionContexts[id] = sessionCtx;
        },
      });
      transport.onclose = () => {
        const id = transport!.sessionId;
        if (id) {
          delete transports[id];
          delete sessionOwners[id];
          sessionContexts[id]?.close();
          delete sessionContexts[id];
        }
      };

      const scopes = authEnabled ? (authInfo?.scopes ?? []) : undefined;
      try {
        let sessionMcp = mcp;
        if (perSession) {
          sessionCtx = new Context(options.appContext!, 'mcp.session');
          // On the fetch path the binder receives the Web `Request` (it has
          // `.headers.get(...)`), not an Express req — the shared SessionBinder
          // type is Express-typed, so cast. Binders targeting native hosts read
          // the Web Request.
          const bind = perSession as unknown as (
            ctx: Context,
            req: Request,
          ) => void | Promise<void>;
          await bind(sessionCtx, req);
          sessionCtx
            .bind(MCPBindings.SERVER.key)
            .toClass(MCPServer)
            .inScope(BindingScope.SINGLETON);
          sessionMcp = await sessionCtx.get(MCPBindings.SERVER);
        }
        await sessionMcp.buildServer({scopes}).connect(transport);
      } catch (err) {
        sessionCtx?.close();
        throw err;
      }
    }

    return transport.handleRequest(req, {parsedBody, authInfo});
  };

  // Register one handler per verb on the same path. addFetchHandler matches
  // (method, exact-path); the SDK transport routes GET (SSE) / POST (RPC) /
  // DELETE (terminate) internally.
  server.addFetchHandler('POST', path, handle);
  server.addFetchHandler('GET', path, handle);
  server.addFetchHandler('DELETE', path, handle);

  return {
    async closeAll() {
      await Promise.all(
        Object.values(transports).map(t => t.close().catch(() => {})),
      );
    },
  };
}
