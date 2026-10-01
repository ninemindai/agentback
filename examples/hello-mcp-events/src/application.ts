// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  AuthenticationBindings,
  type AuthRequest,
} from '@agentback/authentication';
import {MCPComponent, MCPServer} from '@agentback/mcp';
import {installMcpEvents, type WebhookTransport} from '@agentback/mcp-events';
import {installMcpHttp} from '@agentback/mcp-http';
import {RestApplication} from '@agentback/rest';
import {securityId} from '@agentback/security';
import {COMMENTS, CommentStore, CommentTools, DocEvents} from './events.js';

/**
 * Demo bearer tokens → principals. Webhook subscriptions REQUIRE an
 * authenticated principal: it is part of the subscription's identity, which
 * is what stops one caller from unsubscribing (or re-keying) another's. A
 * real deployment uses OAuth — see `installMcpHttp({auth})`.
 */
const DEMO_TOKENS: Record<string, {id: string; scopes: string[]}> = {
  'demo-alice': {id: 'alice', scopes: ['docs:read']},
  'demo-bob': {id: 'bob', scopes: []},
};

class DemoTokenStrategy {
  name = 'demo-token';
  async authenticate(req: AuthRequest) {
    const token = req.headerValue('authorization')?.replace(/^Bearer /i, '');
    const who = token ? DEMO_TOKENS[token] : undefined;
    return who ? {[securityId]: who.id, scopes: who.scopes} : undefined;
  }
}

export interface AppOptions {
  port?: number;
  /**
   * Override how webhooks leave the process. Defaults to the IP-pinned
   * transport; the test passes an in-process stub receiver.
   */
  transport?: WebhookTransport;
}

export async function createApp(opts: AppOptions = {}) {
  const app = new RestApplication({
    rest: {port: opts.port ?? 3000, host: '127.0.0.1'},
  });
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'hello-mcp-events',
    version: '0.0.1',
    transports: {stdio: false},
  });
  app.bind(COMMENTS).to(new CommentStore());
  app.service(DocEvents);
  app.service(CommentTools);
  app
    .bind('strategies.demo-token')
    .toClass(DemoTokenStrategy)
    .tag(AuthenticationBindings.AUTH_STRATEGY);
  await app.get<MCPServer>('servers.MCPServer');

  // Webhook delivery: verification handshake + signed, retried POSTs.
  await installMcpEvents(
    app,
    opts.transport ? {transport: opts.transport} : {},
  );
  // `/mcp`, stateless (both protocol eras). Anonymous callers may list tools
  // and events but cannot subscribe; `comment.created` needs `docs:read`.
  await installMcpHttp(app, {
    strategyAuth: {strategy: 'demo-token', required: false},
  });
  return app;
}
