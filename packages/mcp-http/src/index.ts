// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';
import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {EventStore} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import {requireBearerAuth} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {metadataHandler} from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import type {OAuthTokenVerifier} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {AuthInfo} from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {OAuthProtectedResourceMetadata} from '@modelcontextprotocol/sdk/shared/auth.js';
import {MCPBindings, type MCPServer} from '@agentback/mcp';
import {
  AX_SECTION_TAG,
  type AxSection,
  type RestApplication,
} from '@agentback/rest';
import {
  frameworkAuthGuard,
  type McpStrategyAuthOptions,
} from './framework-auth.js';
import {
  toolRateLimitMiddleware,
  type McpToolRateLimitOptions,
} from './tool-rate-limit.js';

export {InMemoryEventStore} from './event-store.js';
export {
  frameworkAuthGuard,
  type McpStrategyAuthOptions,
} from './framework-auth.js';
export {
  toolRateLimitMiddleware,
  type McpToolRateLimitOptions,
} from './tool-rate-limit.js';
// Re-export so callers can implement a verifier/store without deep SDK imports.
export type {AuthInfo, OAuthTokenVerifier, EventStore};

export interface McpHttpOptions {
  /** URL path the Streamable HTTP transport is mounted at. Default `/mcp`. */
  path?: string;
  /**
   * Reject requests whose `Host`/`Origin` headers are not in the allowlists
   * below — defends a browser-reachable MCP endpoint against DNS-rebinding
   * attacks (a malicious page POSTing to your server). Defaults to `true`
   * when `allowedHosts` or `allowedOrigins` is set, otherwise `false` (so the
   * out-of-the-box dev experience isn't blocked). **Production deployments
   * should set the allowlists** to their real host/origin.
   */
  enableDnsRebindingProtection?: boolean;
  /** Allowed `Host` header values (e.g. `['mcp.example.com']`). */
  allowedHosts?: string[];
  /** Allowed `Origin` header values (e.g. `['https://app.example.com']`). */
  allowedOrigins?: string[];
  /**
   * Enable **resumable** sessions: pass an `EventStore` (e.g. the bundled
   * {@link InMemoryEventStore}, or a Redis-backed one in production) and the
   * transport will replay missed events when a dropped SSE stream reconnects
   * with `Last-Event-ID`. Omit for non-resumable sessions.
   */
  eventStore?: EventStore;
  /**
   * Protect `/mcp` as an OAuth 2.1 **resource server**. When set, every request
   * must carry a valid `Authorization: Bearer <token>`; the endpoint also
   * advertises `/.well-known/oauth-protected-resource` and challenges
   * unauthenticated requests so compliant clients discover the authorization
   * server. The framework is a resource server — bring your own AS (Clerk,
   * Auth0, WorkOS, your own); provide a `verifier` that validates its tokens.
   */
  auth?: McpHttpAuthOptions;
  /**
   * Authenticate `/mcp` with `@agentback/authentication` strategies
   * (jwt / api-key / client-credentials / …) instead of (or alongside) the
   * SDK's OAuth resource-server `auth`. The authenticated principal's scopes
   * drive per-session tool filtering and are bound for tool injection — so MCP
   * tools authenticate the same way as REST routes. {@link installMcpHttp}
   * supplies the DI context automatically.
   */
  strategyAuth?: McpStrategyAuthOptions;
  /**
   * Per-tool, per-caller rate limiting for `tools/call` over HTTP. Each tool
   * gets its own bucket; configure a default plus per-tool overrides.
   */
  rateLimit?: McpToolRateLimitOptions;
}

export interface McpHttpAuthOptions {
  /**
   * Validates a bearer access token and returns its {@link AuthInfo} (scopes,
   * clientId, …). Typically verifies a JWT against the authorization server's
   * JWKS. Throw to reject.
   */
  verifier: OAuthTokenVerifier;
  /**
   * Canonical resource identifier for this MCP endpoint (RFC 8707/9728), e.g.
   * `https://api.example.com/mcp`. Advertised in protected-resource metadata.
   */
  resource: string;
  /** Authorization-server issuer URL(s) advertised to clients (RFC 9728). */
  authorizationServers: string[];
  /** Scopes every caller must hold (beyond per-tool scopes). */
  requiredScopes?: string[];
  /** Scopes advertised in protected-resource metadata (for discovery/docs). */
  scopesSupported?: string[];
}

const DEFAULT_PATH = '/mcp';
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/**
 * Expose the application's in-process MCP server over the MCP **Streamable
 * HTTP** transport, mounted on the RestApplication's Express app. After this,
 * the same `@tool`/`@resource`/`@prompt` surface is reachable by remote MCP
 * clients (Claude, Cursor, agents) — not just a local stdio child.
 *
 * Call BEFORE `app.start()`. Requires `MCPBindings.SERVER` to be bound (add
 * `MCPComponent`).
 *
 * @example
 *   const app = new RestApplication();
 *   app.component(MCPComponent);
 *   app.service(MyTools);
 *   await installMcpHttp(app);        // -> POST/GET/DELETE /mcp
 *   await app.start();
 */
export async function installMcpHttp(
  app: RestApplication,
  options: McpHttpOptions = {},
): Promise<void> {
  if (!app.isBound(MCPBindings.SERVER)) {
    throw new Error(
      '@agentback/mcp-http: no MCP server bound at ' +
        `'${MCPBindings.SERVER.key}'. Add MCPComponent and configure the MCP ` +
        'server before installing the HTTP transport.',
    );
  }
  const mcp = await app.get(MCPBindings.SERVER);
  const server = await app.restServer;
  // Supply the DI context for strategy-based auth from the application.
  const opts: McpHttpOptions =
    options.strategyAuth && !options.strategyAuth.context
      ? {...options, strategyAuth: {...options.strategyAuth, context: app}}
      : options;
  mountMcpHttp(mcp, server.expressApp, opts);

  // Contribute an AX section so the REST server's /llms.txt advertises the
  // MCP surface. Dynamic value: the tool list is computed per request, so
  // tools registered after install still appear.
  const path = opts.path ?? DEFAULT_PATH;
  app
    .bind('ax.sections.mcp')
    .toDynamicValue((): AxSection => {
      const tools = mcp
        .listTools()
        .map(
          t =>
            `- \`${t.meta.name}\`${
              t.meta.description ? ` — ${t.meta.description}` : ''
            }`,
        );
      return {
        title: 'MCP (Model Context Protocol)',
        body:
          `This service is also an MCP server: connect over Streamable ` +
          `HTTP at \`${path}\`.` +
          (tools.length ? `\n\nTools:\n\n${tools.join('\n')}` : ''),
      };
    })
    .tag(AX_SECTION_TAG);
}

/**
 * Lower-level form: mount the Streamable HTTP transport on an Express app for a
 * given {@link MCPServer}. Each MCP session gets its own underlying SDK server
 * (via `mcp.buildServer()`) bound to one transport, keyed by `Mcp-Session-Id`.
 */
export function mountMcpHttp(
  mcp: MCPServer,
  expressApp: Express,
  options: McpHttpOptions = {},
): void {
  const path = options.path ?? DEFAULT_PATH;
  // Default DNS-rebinding protection on when an allowlist is configured.
  const enableDnsRebindingProtection =
    options.enableDnsRebindingProtection ??
    (options.allowedHosts != null || options.allowedOrigins != null);
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const auth = options.auth;

  // Resource-server auth: advertise protected-resource metadata + guard /mcp.
  const guards: RequestHandler[] = [];
  if (auth) {
    const resourceMetadataUrl = new URL(
      PROTECTED_RESOURCE_PATH,
      auth.resource,
    ).toString();
    const metadata: OAuthProtectedResourceMetadata = {
      resource: auth.resource,
      authorization_servers: auth.authorizationServers,
      bearer_methods_supported: ['header'],
      ...(auth.scopesSupported ? {scopes_supported: auth.scopesSupported} : {}),
    };
    // metadataHandler returns a Router whose route is `/`, so it must be
    // mounted with `use` (which strips the prefix), not `get`.
    expressApp.use(PROTECTED_RESOURCE_PATH, metadataHandler(metadata));
    guards.push(
      requireBearerAuth({
        verifier: auth.verifier,
        requiredScopes: auth.requiredScopes,
        resourceMetadataUrl,
      }),
    );
  }

  // Framework-strategy auth: authenticate /mcp with @AgentBack strategies
  // and set req.auth (scopes drive tool filtering; principal is bound for tools).
  const strategyAuth = options.strategyAuth;
  if (strategyAuth) {
    if (!strategyAuth.context) {
      throw new Error(
        '@agentback/mcp-http: strategyAuth.context is required ' +
          '(installMcpHttp sets it automatically).',
      );
    }
    guards.push(
      frameworkAuthGuard({...strategyAuth, context: strategyAuth.context}),
    );
  }

  const toolRateLimit = options.rateLimit
    ? [toolRateLimitMiddleware(options.rateLimit)]
    : [];

  const rpcError = (res: Response, status: number, message: string) =>
    res
      .status(status)
      .json({jsonrpc: '2.0', error: {code: -32000, message}, id: null});

  // POST: client → server JSON-RPC. A request with no session must be an
  // `initialize`, which spins up a fresh per-session SDK server + transport.
  expressApp.post(
    path,
    ...guards,
    express.json(),
    ...toolRateLimit,
    async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        if (sessionId) {
          rpcError(res, 404, `Unknown MCP session: ${sessionId}`);
          return;
        }
        if (!isInitializeRequest(req.body)) {
          rpcError(
            res,
            400,
            'No active MCP session and request is not an initialize request',
          );
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableDnsRebindingProtection,
          ...(options.allowedHosts ? {allowedHosts: options.allowedHosts} : {}),
          ...(options.allowedOrigins
            ? {allowedOrigins: options.allowedOrigins}
            : {}),
          ...(options.eventStore ? {eventStore: options.eventStore} : {}),
          onsessioninitialized: id => {
            transports[id] = transport!;
          },
        });
        transport.onclose = () => {
          const id = transport!.sessionId;
          if (id && transports[id]) delete transports[id];
        };
        // A fresh SDK server per session — one McpServer can only be connected to
        // a single live transport at a time. When auth is on, the session only
        // sees tools whose `scope` is covered by the caller's granted scopes.
        const scopes =
          auth || strategyAuth
            ? ((req.auth as AuthInfo | undefined)?.scopes ?? [])
            : undefined;
        await mcp.buildServer({scopes}).connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    },
  );

  // GET: opens the SSE stream for server → client messages on a session.
  // DELETE: terminates a session.
  const onSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send('Missing or unknown Mcp-Session-Id');
      return;
    }
    await transport.handleRequest(req, res);
  };
  expressApp.get(path, ...guards, onSessionRequest);
  expressApp.delete(path, ...guards, onSessionRequest);
}
