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
    // For local development; replace with real auth for any non-loopback deploy.
    unsafeAllowUnauthenticated: true,
  });

  await app.start();
  // REST: GET /hello/{name}, /openapi.json
  // MCP (incl. introspection): /mcp
  // Console: /console  (agent dock: /console/chat/agents, /console/chat/stream, …)
}

if (isMain(import.meta)) {
  await main();
}
