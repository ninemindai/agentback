// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-hybrid — one app exposing REST and MCP from the same DI container.
// Routes:
//   GET  /greet/hello/:name      (REST controller)
//   POST /greet/echo             (REST controller, Zod-validated body)
//   GET  /openapi.json           (OpenAPI 3.1.1)
//   GET  /explorer/              (Swagger UI)
//   GET  /mcp-inspector/         (MCP Inspector UI)
//   POST /mcp-inspector/api/tools/:name/call  (inspector call API)

import {z} from 'zod';
import {isMain} from '@agentback/core';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {installExplorer} from '@agentback/rest-explorer';
import {
  MCPComponent,
  mcpServer,
  prompt,
  resource,
  tool,
} from '@agentback/mcp';
import {installInspector} from '@agentback/mcp-inspector';
import {installMcpHttp} from '@agentback/mcp-http';

// ---- REST controller ----

const Greeting = z.object({greeting: z.string()});
const HelloPath = z.object({name: z.string().min(1).max(64)});
const EchoIn = z.object({text: z.string().min(1).max(280)});
const EchoOut = z.object({echoed: z.string(), at: z.string()});

@api({basePath: '/greet'})
class GreetingController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {greeting: `Hello, ${input.path.name}!`};
  }

  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(input: {
    body: z.infer<typeof EchoIn>;
  }): Promise<z.infer<typeof EchoOut>> {
    return {echoed: input.body.text, at: new Date().toISOString()};
  }
}

// ---- MCP controller ----

const McpEchoInput = z.object({text: z.string().min(1).max(280)});
const McpAddInput = z.object({a: z.number().int(), b: z.number().int()});

@mcpServer()
class EchoTools {
  @tool('echo', {
    description: 'Echoes back the text you send.',
    input: McpEchoInput,
  })
  async echo(input: z.infer<typeof McpEchoInput>) {
    return {echoed: input.text, at: new Date().toISOString()};
  }

  @tool('add', {description: 'Adds two integers.', input: McpAddInput})
  async add(input: z.infer<typeof McpAddInput>) {
    return {sum: input.a + input.b};
  }

  @resource('hello://motd', {
    name: 'motd',
    description: 'Message of the day.',
    mimeType: 'text/plain',
  })
  motd() {
    return 'Hello from the hello-hybrid MCP server.';
  }

  @prompt('welcome', {description: 'A short welcome prompt.'})
  welcome() {
    return 'Welcome! Try the echo and add tools.';
  }
}

// ---- Bootstrap ----

async function main() {
  const app = new RestApplication();

  // MCP: register the component (binds MCPServer) and configure transports.
  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'hello-hybrid',
    version: '0.0.0',
    transports: {stdio: false},
  });

  // Bind controllers. @mcpServer() on EchoTools attaches the binding tag
  // via @bind metadata, which app.service() honors automatically.
  app.restController(GreetingController);
  app.service(EchoTools);

  // Mount Swagger UI for REST and the MCP inspector. The inspector resolves
  // the MCP server from DI, so no instance needs to be passed.
  await installExplorer(app, {title: 'hello-hybrid REST'});
  // The `connect` option also mounts @agentback/mcp-connect, so the
  // inspector can connect to REMOTE MCP servers (none/bearer/OAuth) and proxy
  // their tools — switch targets with the "Server" dropdown in the header.
  // `allowPrivateTargets` is enabled here so this local demo can reach servers
  // on localhost; LEAVE IT OFF (the default) in production — it's an SSRF guard
  // that blocks loopback/private/cloud-metadata addresses. Gate the endpoint
  // behind auth when exposing it publicly.
  await installInspector(app, {
    title: 'hello-hybrid MCP',
    connect: {allowPrivateTargets: true},
  });

  // Expose the in-process MCP server over Streamable HTTP at /mcp so remote
  // MCP clients (Claude, Cursor, agents) can reach the same tools.
  await installMcpHttp(app);

  await app.start();
  const server = await app.restServer;
  console.log(`hello-hybrid listening at ${server.url}`);
  console.log(`  REST:`);
  console.log(`    GET  ${server.url}/greet/hello/world`);
  console.log(`    POST ${server.url}/greet/echo  (body: {"text":"hi"})`);
  console.log(`    GET  ${server.url}/openapi.json`);
  console.log(`    GET  ${server.url}/explorer/`);
  console.log(`  MCP:`);
  console.log(
    `    POST ${server.url}/mcp            (Streamable HTTP transport)`,
  );
  console.log(`    GET  ${server.url}/mcp-inspector/`);
  console.log(`    GET  ${server.url}/mcp-inspector/api/manifest`);
  console.log(`    POST ${server.url}/mcp-inspector/api/tools/echo/call`);
  console.log(
    `    (inspector "Server" dropdown → add a remote MCP server: none/bearer/OAuth)`,
  );
}

// Boot only when this module is the entry point, not when imported.
if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
