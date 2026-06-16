// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Request, RequestHandler, Response} from 'express';
import type {Context} from '@agentback/core';
import {
  fromExpressRequest,
  normalizeAuthResult,
  resolveStrategy,
  type AuthenticationResult,
} from '@agentback/authentication';
import {
  securityId,
  type ClientApplication,
  type UserProfile,
} from '@agentback/security';
import type {AuthInfo} from '@modelcontextprotocol/sdk/server/auth/types.js';

export interface McpStrategyAuthOptions {
  /**
   * DI context used to resolve authentication strategies (by the
   * `authentication.strategy` tag). {@link installMcpHttp} defaults this to the
   * application; pass it explicitly when using {@link mountMcpHttp} directly.
   */
  context?: Context;
  /**
   * Strategy name(s) from `@agentback/authentication` to try, in order
   * (e.g. `'jwt'` or `['api-key', 'jwt']`). The first that authenticates wins.
   */
  strategy: string | string[];
  /** Respond 401 when no strategy authenticates the request. Default true. */
  required?: boolean;
  /**
   * Map the authenticated principal to the MCP scopes used for tool filtering.
   * Default: the user's `scopes`, else the client application's `allowedScopes`.
   */
  scopes?: (auth: AuthenticationResult) => string[];
}

type PrincipalScopes = UserProfile & {scopes?: string[] | string};

/** Derive MCP scopes from the authenticated principal. */
function defaultScopes(auth: AuthenticationResult): string[] {
  const principal = (auth.user ?? auth.clientApplication) as
    | PrincipalScopes
    | undefined;
  const raw = principal?.scopes ?? auth.clientApplication?.allowedScopes;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return raw.split(' ').filter(Boolean);
  return [];
}

function unauthorized(res: Response): void {
  res.status(401).json({
    jsonrpc: '2.0',
    error: {code: -32001, message: 'Unauthorized'},
    id: null,
  });
}

/**
 * Express guard that authenticates an MCP-over-HTTP request using
 * `@agentback/authentication` strategies (jwt / api-key /
 * client-credentials / anonymous / your own). On success it sets `req.auth`
 * (an MCP {@link AuthInfo}) carrying the derived scopes and the resolved
 * principal in `extra` — so the existing transport wiring filters tools by
 * scope (`buildServer({scopes})`) and binds `MCPBindings.REQUEST_AUTH` for
 * tool injection, exactly like REST routes authenticate.
 */
export function frameworkAuthGuard(
  options: McpStrategyAuthOptions & {context: Context},
): RequestHandler {
  const names = Array.isArray(options.strategy)
    ? options.strategy
    : [options.strategy];
  const required = options.required ?? true;
  const toScopes = options.scopes ?? defaultScopes;

  return (req: Request, res: Response, next) => {
    void (async () => {
      const authReq = fromExpressRequest(req);
      let result: AuthenticationResult | undefined;
      for (const name of names) {
        const strategy = await resolveStrategy(options.context, name);
        if (!strategy) continue;
        try {
          const norm = normalizeAuthResult(
            await strategy.authenticate(authReq),
          );
          if (norm.user || norm.clientApplication) {
            result = norm;
            break;
          }
        } catch {
          // Try the next strategy; fall through to the required/optional gate.
        }
      }

      if (!result) {
        if (required) unauthorized(res);
        else next();
        return;
      }

      const principal: ClientApplication | UserProfile | undefined =
        result.user ?? result.clientApplication;
      const authInfo: AuthInfo = {
        token: 'framework',
        clientId: principal ? principal[securityId] : 'unknown',
        scopes: toScopes(result),
        extra: {user: result.user, clientApplication: result.clientApplication},
      };
      (req as Request & {auth?: AuthInfo}).auth = authInfo;
      next();
    })().catch(() => unauthorized(res));
  };
}
