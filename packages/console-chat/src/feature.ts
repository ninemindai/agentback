// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RestApplication} from '@agentback/rest';
import {RestBindings} from '@agentback/rest';
import {SecurityBindings, securityId} from '@agentback/security';
import type {UserProfile} from '@agentback/security';
import type {ConsoleFeature} from '@agentback/console';
import type {Request, Response} from 'express';
import type {ChatConsoleConfig} from './types.js';
import {ChatBridgeController, handleSseRequest} from './bridge.controller.js';
import {discoverAgents, BUILTIN_AGENTS} from './agents.js';

/**
 * Server-side feature for the chat dock.
 *
 * Registers the `ChatBridgeController` REST endpoints and advertises the
 * `window.__CONSOLE__.chat` config block to the browser shell.
 *
 * C2 fix: the SSE `GET /console/chat/stream` handler is mounted directly on
 * `server.expressApp` (like `mountMcpHttp` in `@agentback/mcp-http`) so that
 * `RestServer.sendResult` never gets to call `res.end()` on it.  The framework
 * `@get('/stream', …)` decorator is kept for OpenAPI schema generation only.
 *
 * @param config - Chat dock configuration (all fields optional).
 */
export function chatConsoleFeature(
  config: ChatConsoleConfig = {},
): ConsoleFeature & {
  chatConfig: {enabled: boolean; apiBase: string; agents: {id: string; name: string}[]};
} {
  const enabled = config.enabled ?? false;
  const apiBase = '/console/chat';
  // agents list starts empty; it is populated lazily on first /agents call.
  const agents: {id: string; name: string}[] = [];

  return {
    id: 'chat',
    apiBase,
    extra: {chat: {enabled, apiBase, agents}},

    async install(app: RestApplication): Promise<void> {
      if (!enabled) return;

      // Register the bridge controller (all non-SSE endpoints).
      app.restController(ChatBridgeController);

      // C2: Mount the SSE endpoint directly on expressApp BEFORE app.start(),
      // matching the mcp-http pattern.  Express matches this route before the
      // framework's route table, so RestServer.sendResult never runs for it.
      const server = await app.restServer;
      const expressApp = server.expressApp;

      expressApp.get('/console/chat/stream', async (req: Request, res: Response) => {
        // Resolve the controller AFTER start() so its DI bindings are ready.
        // We await app.get() here to get the singleton ChatBridgeController.
        let controller: ChatBridgeController;
        try {
          controller = await app.get<ChatBridgeController>('controllers.ChatBridgeController');
        } catch {
          res.status(500).json({error: 'internal_error', message: 'Chat bridge not ready'});
          return;
        }

        // Derive the principal from the authenticated security context.
        // SecurityBindings.USER is bound per-request by auth middleware.
        // We resolve it from the request-scoped context if available;
        // otherwise fall through to requirePrincipal's 401 rejection.
        let user: UserProfile | undefined;
        try {
          // The RestServer binds SecurityBindings.USER into a per-request Context.
          // For the raw expressApp handler we read it from the request's auth
          // attachment set by framework auth middleware (same path as mcp-http).
          // If no auth middleware is installed, req.auth is undefined → 401.
          user = (req as Request & {auth?: UserProfile}).auth;
        } catch {
          // No auth context — 401 below.
        }

        if (!user) {
          res.status(401).json({error: 'unauthenticated', message: 'Authentication required'});
          return;
        }

        const sessionId = (req.query as Record<string, string | undefined>)['sessionId'];
        if (!sessionId || typeof sessionId !== 'string') {
          res.status(400).json({error: 'invalid_request', message: 'sessionId query param required'});
          return;
        }

        handleSseRequest(controller.sessions, user[securityId], sessionId, req, res);
      });

      // Eagerly run discovery and update the agents list so the console shell
      // gets an accurate initial set without a round-trip.
      const found = await discoverAgents([
        ...BUILTIN_AGENTS,
        ...(config.agents ?? []),
      ]).catch(() => []);

      agents.splice(0, agents.length, ...found);
    },

    // Expose the typed chat config for window.__CONSOLE__.chat injection.
    chatConfig: {enabled, apiBase, agents},
  };
}
