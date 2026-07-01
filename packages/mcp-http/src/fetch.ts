import {
  InsufficientScopeError,
  InvalidTokenError,
  OAuthError,
  ServerError,
} from '@modelcontextprotocol/server-legacy/auth';
import {
  WebStandardStreamableHTTPServerTransport,
  isInitializeRequest,
} from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  OAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/server';

// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/
import {
  fromWebRequest,
  normalizeAuthResult,
  resolveStrategy,
  type AuthenticationResult,
} from '@agentback/authentication';
import {securityId} from '@agentback/security';
import {BindingScope, Context} from '@agentback/core';
import {MCPBindings, MCPServer} from '@agentback/mcp';
import type {RestServer} from '@agentback/rest';
import type {McpHttpOptions, McpHttpHandle} from './index.js';

const DEFAULT_PATH = '/mcp';
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/**
 * Verify the `Authorization: Bearer` token on a Web `Request` using the
 * configured OAuth verifier — the runtime-neutral mirror of the SDK's
 * `requireBearerAuth` Express middleware (RFC 6750/9728). Returns the verified
 * {@link AuthInfo} on success, or a 401/403/4xx Web `Response` carrying the
 * `WWW-Authenticate` challenge on failure.
 */
async function verifyBearerFetch(
  req: Request,
  verifier: {verifyAccessToken(token: string): Promise<AuthInfo>},
  requiredScopes: string[],
  resourceMetadataUrl: string,
): Promise<AuthInfo | Response> {
  const buildHeader = (errorCode: string, message: string): string => {
    let header = `Bearer error="${errorCode}", error_description="${message}"`;
    if (requiredScopes.length > 0)
      header += `, scope="${requiredScopes.join(' ')}"`;
    header += `, resource_metadata="${resourceMetadataUrl}"`;
    return header;
  };
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader)
      throw new InvalidTokenError('Missing Authorization header');
    const [type, token] = authHeader.split(' ');
    if (type?.toLowerCase() !== 'bearer' || !token) {
      throw new InvalidTokenError(
        "Invalid Authorization header format, expected 'Bearer TOKEN'",
      );
    }
    const authInfo = await verifier.verifyAccessToken(token);
    if (
      requiredScopes.length > 0 &&
      !requiredScopes.every(s => authInfo.scopes.includes(s))
    ) {
      throw new InsufficientScopeError('Insufficient scope');
    }
    if (typeof authInfo.expiresAt !== 'number' || isNaN(authInfo.expiresAt)) {
      throw new InvalidTokenError('Token has no expiration time');
    }
    if (authInfo.expiresAt < Date.now() / 1000) {
      throw new InvalidTokenError('Token has expired');
    }
    return authInfo;
  } catch (error) {
    if (error instanceof InvalidTokenError) {
      return Response.json(error.toResponseObject(), {
        status: 401,
        headers: {
          'WWW-Authenticate': buildHeader(error.errorCode, error.message),
        },
      });
    }
    if (error instanceof InsufficientScopeError) {
      return Response.json(error.toResponseObject(), {
        status: 403,
        headers: {
          'WWW-Authenticate': buildHeader(error.errorCode, error.message),
        },
      });
    }
    if (error instanceof ServerError) {
      return Response.json(error.toResponseObject(), {status: 500});
    }
    if (error instanceof OAuthError) {
      return Response.json(error.toResponseObject(), {status: 400});
    }
    return Response.json(
      new ServerError('Internal Server Error').toResponseObject(),
      {
        status: 500,
      },
    );
  }
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
 * (`options.auth`, via {@link verifyBearerFetch} + the
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
    // Authenticate once per request. OAuth bearer (resource-server) runs first
    // when configured; otherwise strategy-based auth. Either can gate the call.
    let authInfo: AuthInfo | undefined;
    if (oauth) {
      const verified = await verifyBearerFetch(
        req,
        oauth.verifier,
        oauth.requiredScopes ?? [],
        resourceMetadataUrl,
      );
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
    server.addFetchHandler('GET', PROTECTED_RESOURCE_PATH, async () =>
      Response.json(metadata),
    );
  }

  return {
    async closeAll() {
      await Promise.all(
        Object.values(transports).map(t => t.close().catch(() => {})),
      );
    },
  };
}
