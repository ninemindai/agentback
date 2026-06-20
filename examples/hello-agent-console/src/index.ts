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
  app.service(IntrospectionTools);
  await installMcpHttp(app);
  await app.start();
  // The app's MCP surface (including introspection) is now at /mcp.
  // Point your agent's MCP client at http://localhost:3000/mcp to let it
  // `inventory`, `get`, and `get_okf_bundle` against this live app.
}

if (isMain(import.meta)) {
  await main();
}
