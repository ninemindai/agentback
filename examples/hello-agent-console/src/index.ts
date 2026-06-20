// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {isMain} from '@agentback/core';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {IntrospectionTools} from '@agentback/introspection';
import {installConsole, defaultFeatures} from '@agentback/console';
import {chatConsoleFeature} from '@agentback/console-chat';

const Greeting = z.object({message: z.string()});
const HelloPath = z.object({name: z.string().min(1).max(64)});

@api({basePath: '/'})
class HelloController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {message: `Hello, ${input.path.name}!`};
  }
}

/**
 * DEV ONLY — loopback auth middleware.
 *
 * Sets `req.auth` to a fixed local principal so the agent dock is fully
 * functional when running on 127.0.0.1 (the default bind). This simulates
 * what a real auth middleware (JWT, session cookie, API key, etc.) would do
 * in production.
 *
 * REPLACE WITH REAL AUTH BEFORE ANY NON-LOOPBACK DEPLOY.
 * Never expose a process-spawning endpoint to any network beyond loopback
 * without proper authentication.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function devLoopbackAuth(req: any, _res: unknown, next: () => void): void {
  (req as {auth: {token: string; clientId: string; scopes: string[]}}).auth = {
    token: 'dev-loopback',
    clientId: 'local-dev',
    scopes: [],
  };
  next();
}

async function main(): Promise<void> {
  const app = new RestApplication();
  app.component(MCPComponent);
  app.restController(HelloController);

  // Phase 1: introspection tools — any agent can call inventory/get/get_okf_bundle
  // on this app's MCP surface at /mcp.
  app.service(IntrospectionTools);
  await installMcpHttp(app);

  // Phase 2: developer console at /console — context, schema, REST, MCP explorers
  // plus the agent chat dock (hidden until >=1 ACP agent is discovered).
  //
  // SECURITY: chat is off-by-default and gated behind the console auth middleware.
  // The dock only renders when >=1 agent is discovered (PATH probe); it does not
  // expose the bridge endpoints at all when chat.enabled is false.
  // For local development only — never expose beyond loopback without real auth.
  const chat = chatConsoleFeature({
    enabled: true,
    introspection: true, // ground the agent in the live app via IntrospectionTools
  });

  await installConsole(app, {
    features: [...defaultFeatures(), chat],
    // DEV ONLY: devLoopbackAuth sets req.auth to a fixed local-dev principal so
    // the bridge endpoints work. The server is bound to 127.0.0.1 by default —
    // replace with real auth before any non-loopback deploy.
    auth: devLoopbackAuth,
  });

  await app.start();
  // REST: GET /hello/{name}, /openapi.json
  // MCP (incl. introspection): /mcp
  // Console: /console  (agent dock: /console/chat/agents, /console/chat/stream, …)
}

if (isMain(import.meta)) {
  await main();
}
