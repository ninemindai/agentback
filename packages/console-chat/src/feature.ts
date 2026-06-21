// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RestApplication} from '@agentback/rest';
import type {ConsoleFeature} from '@agentback/console';
import type {Request, Response} from 'express';
import type {ChatConsoleConfig} from './types.js';
import {loggers} from '@agentback/common';
import {ChatBridgeController, CHAT_DISCOVER, handleSseRequest, principalFromRequest} from './bridge.controller.js';
import {discoverAgents, makeProbe, BUILTIN_AGENTS} from './agents.js';

const log = loggers('agentback:console-chat:feature');

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
  const featureEnabled = config.enabled ?? false;
  const apiBase = '/console/chat';
  // agents list starts empty; it is populated by eager discovery in install().
  const agents: {id: string; name: string}[] = [];
  // The shell renders the dock only when `chatConfig.enabled` is true. Per spec
  // Decision #2 ("when no agent is discovered or configured, the dock does NOT
  // render"), this reflects BOTH the feature gate AND a non-empty discovered
  // agent set — computed after eager discovery below. A single mutable object is
  // shared with `extra.chat` so the shell sees the post-discovery value.
  const chatConfig = {enabled: false, apiBase, agents};

  return {
    id: 'chat',
    apiBase,
    extra: {chat: chatConfig},

    async install(app: RestApplication): Promise<void> {
      if (!featureEnabled) return;

      // I-2: Edge / native-listener guard.
      // `chatConsoleFeature` requires the Express host (child_process + SSE).
      // On an EdgeRestApplication (listener === 'native') there is no Express
      // app and no child_process available — log a warning and no-op instead of
      // throwing.  Mirrors the detection used by installMcpHttp
      // (packages/mcp-http/src/index.ts:232).
      const server = await app.restServer;
      if (server.listener === 'native') {
        log.warn(
          'chatConsoleFeature: skipping install — the REST server uses ' +
          "listener:'native' (EdgeRestApplication). The chat dock requires " +
          "the Express host (listener:'express' / RestApplication). No " +
          'bridge endpoints will be registered.',
        );
        return;
      }

      // Register the bridge controller (all non-SSE endpoints).
      app.restController(ChatBridgeController);

      // Bind a cwd-aware discover function so GET /agents uses buildAugmentedPath(cwd)
      // instead of the static defaultProbe. This ensures workspace devDependency
      // adapters (under the consumer package's node_modules/.bin) are found without
      // a global install. The binding must be done before start() so the singleton
      // ChatBridgeController resolves it from its @inject(CHAT_DISCOVER) constructor param.
      const catalog = [...BUILTIN_AGENTS, ...(config.agents ?? [])];
      const probe = makeProbe(config.cwd);
      app.bind(CHAT_DISCOVER.key).to(
        () => discoverAgents(catalog, probe),
      );

      // I-1: Wire disposeAll on app shutdown so ACP subprocesses are killed
      // and never orphaned.  The controller singleton is resolved lazily on the
      // first shutdown (it may not exist if start() was never called), so we
      // use app.get() inside the callback.  Mirrors installMcpHttp's pattern:
      //   app.onStop(() => handle.closeAll())
      app.onStop(async () => {
        try {
          const controller = await app.get<ChatBridgeController>(
            'controllers.ChatBridgeController',
          );
          controller.disposeAll();
        } catch {
          // Controller was never bound (e.g. start() was skipped) — nothing
          // to drain; swallow silently.
        }
      });

      // C2: Mount the SSE endpoint directly on expressApp BEFORE app.start(),
      // matching the mcp-http pattern.  Express matches this route before the
      // framework's route table, so RestServer.sendResult never runs for it.
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

        // Derive the principal from req.auth — set by the console `auth` guard
        // middleware (same source as the @api bridge endpoints).  Uses the same
        // `principalFromRequest` helper so both paths are guaranteed to produce
        // the same principal id and the same 401 behaviour.
        let principal: string;
        try {
          principal = principalFromRequest(req);
        } catch {
          res.status(401).json({error: 'unauthenticated', message: 'Authentication required'});
          return;
        }

        const sessionId = (req.query as Record<string, string | undefined>)['sessionId'];
        if (!sessionId || typeof sessionId !== 'string') {
          res.status(400).json({error: 'invalid_request', message: 'sessionId query param required'});
          return;
        }

        handleSseRequest(controller.sessions, principal, sessionId, req, res);
      });

      // Eagerly run discovery and update the agents list so the console shell
      // gets an accurate initial set without a round-trip. Probe from
      // `config.cwd` (the app's own dir) so a workspace devDependency adapter —
      // whose bin pnpm isolates under the consuming package's node_modules/.bin,
      // NOT process.cwd() — is discoverable without a global install.
      const found = await discoverAgents(
        [...BUILTIN_AGENTS, ...(config.agents ?? [])],
        makeProbe(config.cwd),
      ).catch(() => []);

      agents.splice(0, agents.length, ...found);

      // Option B / spec Decision #2: the dock renders only when an agent was
      // actually discovered. With zero agents, hide the dock entirely rather
      // than showing a no-agent state.
      chatConfig.enabled = featureEnabled && agents.length > 0;
    },

    // Expose the typed chat config for window.__CONSOLE__.chat injection.
    chatConfig,
  };
}
