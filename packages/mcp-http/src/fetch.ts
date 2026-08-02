// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  hostHeaderValidationResponse,
  isInitializeRequest,
  originValidationResponse,
  requireBearerAuth,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/server';

import {
  fromWebRequest,
  normalizeAuthResult,
  resolveStrategy,
  type AuthenticationResult,
} from '@agentback/authentication';
import {securityId} from '@agentback/security';
import {Context} from '@agentback/core';
import {MCPServer} from '@agentback/mcp';
import type {RestServer} from '@agentback/rest';
import type {McpHttpOptions, McpHttpHandle} from './index.js';
import {createToolRateLimiter, rateLimitErrorBody} from './tool-rate-limit.js';
import {
  resolveSessionServer,
  setupStateless,
  withSessionIdExposed,
} from './session.js';

const DEFAULT_PATH = '/mcp';
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/**
 * CORS headers for the public RFC 9728 discovery document. Open by design —
 * the metadata is unauthenticated and browser MCP clients must read it
 * cross-origin. Mirrors what SDK v1's `metadataHandler` got from `cors()`.
 */
export const PUBLIC_DISCOVERY_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

/**
 * Verify the `Authorization: Bearer` token on a Web `Request` (RFC 6750/9728),
 * returning the verified {@link AuthInfo} or a 401/403/5xx `Response` carrying
 * the `WWW-Authenticate` challenge.
 *
 * This is the SDK's own runtime-neutral guard. SDK v1 shipped `requireBearerAuth`
 * only as Express middleware, so this file hand-rolled a fetch-shaped equivalent;
 * v2 ships one with an identical `Request -> AuthInfo | Response` contract, so
 * the hand-rolled copy is gone. Note the verifier must throw the v2 `OAuthError`
 * — the guard classifies by that class, and anything else becomes a 500 rather
 * than a 401.
 */
function bearerGuard(
  auth: NonNullable<McpHttpOptions['auth']>,
  resourceMetadataUrl: string,
): (req: Request) => Promise<AuthInfo | Response> {
  return requireBearerAuth({
    verifier: auth.verifier,
    ...(auth.requiredScopes ? {requiredScopes: auth.requiredScopes} : {}),
    resourceMetadataUrl,
  });
}

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
  const scopes = toScopes ? toScopes(result) : defaultScopes(result);
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
    {scopes?: string[] | string} | undefined;
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
 * support as the Express mount. Full auth parity: OAuth resource-server bearer
 * (`options.auth`, via {@link bearerGuard} + the
 * `/.well-known/oauth-protected-resource` metadata route) and `strategyAuth`
 * (via the neutral {@link fromWebRequest} seam) are both honored.
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
  const oauth = options.auth;
  const authEnabled = Boolean(strategyAuth || oauth);

  // OAuth resource-server bearer: precompute the protected-resource metadata
  // URL + document (advertised at /.well-known/oauth-protected-resource).
  const resourceMetadataUrl = oauth
    ? new URL(PROTECTED_RESOURCE_PATH, oauth.resource).toString()
    : '';
  // Built once: the guard closes over the verifier and challenge metadata.
  const verifyBearer = oauth
    ? bearerGuard(oauth, resourceMetadataUrl)
    : undefined;

  // Stateless (2026-07-28 + 2025 from one endpoint): one handler, built once,
  // which calls the factory per REQUEST. There is no session map, no principal
  // pinning (every request re-authenticates above) and no GET/DELETE session
  // ops — the SDK answers those 405.
  const {
    handler: statelessHandler,
    allowedHostnames,
    allowedOriginHostnames,
  } = setupStateless(mcp, options);

  // Per-tool throttling. This host has no middleware chain, so rather than
  // mounting middleware it applies the shared decision core inline, below.
  // (Until this existed, configuring `rateLimit` here threw at mount: the
  // option was Express-only, `installMcpHttp` picks the host automatically from
  // `rest.listener`, and silently not throttling shows up as a bill rather than
  // an error.)
  const rateLimiter = options.rateLimit
    ? createToolRateLimiter(options.rateLimit)
    : undefined;

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
    // Rebinding checks run BEFORE auth: this is a transport-level gate, and a
    // request from a disallowed host should be refused without spending a token
    // verification on it. Mirrors the Express mount, where these guards sit
    // ahead of the auth guards.
    if (allowedHostnames) {
      const rejected = hostHeaderValidationResponse(req, allowedHostnames);
      if (rejected) return rejected;
    }
    if (allowedOriginHostnames) {
      const rejected = originValidationResponse(req, allowedOriginHostnames);
      if (rejected) return rejected;
    }

    // Authenticate once per request. OAuth bearer (resource-server) runs first
    // when configured; otherwise strategy-based auth. Either can gate the call.
    let authInfo: AuthInfo | undefined;
    if (oauth) {
      const verified = await verifyBearer!(req);
      if (verified instanceof Response) return verified; // 401/403/4xx challenge
      authInfo = verified;
    } else if (strategyAuth) {
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
    // POST may carry a body; read it once and hand it to the SDK as parsedBody
    // (a Web Request body is single-read). GET/DELETE carry none.
    //
    // Read BEFORE the stateless branch: rate limiting needs to see the
    // JSON-RPC method, and both paths need the already-consumed body passed
    // through rather than re-read from a spent stream.
    let parsedBody: unknown;
    if (req.method === 'POST') {
      try {
        parsedBody = await req.json();
      } catch {
        parsedBody = undefined;
      }
    }

    if (rateLimiter) {
      const decision = await rateLimiter.check(parsedBody, {
        ...(authInfo ? {authInfo} : {}),
        header: name => req.headers.get(name) ?? undefined,
        // No `ip`: see RateLimitCaller.ip — this host has no trustworthy
        // source for one, and a spoofable header is worse than none.
      });
      if (!decision.ok) {
        return Response.json(rateLimitErrorBody(decision.tool, decision.id), {
          status: 429,
          headers: {'retry-after': String(decision.retryAfterSecs)},
        });
      }
    }

    if (statelessHandler) {
      // `authInfo` is strict pass-through: the SDK verifies nothing itself, so
      // the guard above stays the only authority.
      return statelessHandler.fetch(req, {
        ...(authInfo ? {authInfo} : {}),
        ...(parsedBody !== undefined ? {parsedBody} : {}),
      });
    }

    const principal = authInfo?.clientId;

    const sessionId = req.headers.get('mcp-session-id') ?? undefined;
    let transport = sessionId ? transports[sessionId] : undefined;

    if (transport && sessionId && !ownsSession(sessionId, principal)) {
      return rpcError(403, 'MCP session belongs to a different principal');
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
          // No cast: the binder takes a Web `Request` on every host, which is
          // what this path already had natively.
          const resolved = await resolveSessionServer({
            appContext: options.appContext!,
            binder: perSession,
            request: req,
            ...(authInfo ? {authInfo} : {}),
          });
          sessionCtx = resolved.sessionCtx;
          sessionMcp = resolved.mcp;
        }
        await sessionMcp.buildServer({scopes}).connect(transport);
      } catch (err) {
        sessionCtx?.close();
        throw err;
      }
    }

    const res = await transport.handleRequest(req, {parsedBody, authInfo});
    // Let a cross-origin browser client READ the session id the SDK just
    // minted. Inert unless the app configured `rest.cors` — see
    // `withSessionIdExposed`.
    const headers = new Headers(res.headers);
    headers.set(
      'access-control-expose-headers',
      withSessionIdExposed(headers.get('access-control-expose-headers')),
    );
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };

  // Register one handler per verb on the same path. addFetchHandler matches
  // (method, exact-path); the SDK transport routes GET (SSE) / POST (RPC) /
  // DELETE (terminate) internally.
  server.addFetchHandler('POST', path, handle);
  server.addFetchHandler('GET', path, handle);
  server.addFetchHandler('DELETE', path, handle);

  // OAuth resource-server metadata (RFC 9728): advertise the authorization
  // servers + scopes so clients can discover where to obtain a token.
  if (oauth) {
    const metadata: OAuthProtectedResourceMetadata = {
      resource: oauth.resource,
      authorization_servers: oauth.authorizationServers,
      bearer_methods_supported: ['header'],
      ...(oauth.scopesSupported
        ? {scopes_supported: oauth.scopesSupported}
        : {}),
    };
    // The discovery document is public by spec and browser-hosted MCP clients
    // fetch it cross-origin with a custom `MCP-Protocol-Version` header, which
    // forces a preflight — so OPTIONS must answer with the CORS headers too.
    server.addFetchHandler('GET', PROTECTED_RESOURCE_PATH, async () =>
      Response.json(metadata, {headers: PUBLIC_DISCOVERY_CORS}),
    );
    server.addFetchHandler(
      'OPTIONS',
      PROTECTED_RESOURCE_PATH,
      async () =>
        new Response(null, {status: 204, headers: PUBLIC_DISCOVERY_CORS}),
    );
  }

  return {
    async closeAll() {
      await statelessHandler?.close();
      await Promise.all(
        Object.values(transports).map(t => t.close().catch(() => {})),
      );
    },
  };
}
