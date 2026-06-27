// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-console — one app, one unified developer console composing the
// context explorer, the REST/OpenAPI (Swagger) explorer, and the MCP inspector
// behind a single shell at /console.
//
//   GET  /console/                 (the unified console UI)
//   GET  /context-explorer/api/*   (context panel API)
//   GET  /explorer/                (API panel, embedded as an iframe)
//   GET  /mcp-inspector/api/*      (MCP panel API)
//   POST /mcp/                     (Streamable HTTP MCP transport)

import {z} from 'zod';
import {isMain} from '@agentback/core';
import {api, get, post} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {
  MCPComponent,
  MCPServer,
  mcpServer,
  prompt,
  resource,
  tool,
} from '@agentback/mcp';
import {installConsole} from '@agentback/console';

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

// ---- MCP tools ----

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
    return 'Hello from the hello-console MCP server.';
  }

  @prompt('welcome', {description: 'A short welcome prompt.'})
  welcome() {
    return 'Welcome! Browse the bindings, the API, and the MCP tools.';
  }
}

// ---- Bootstrap ----

/**
 * Build and start the app. Shared by the CLI entry (below) and the Vercel
 * serverless handler (`api/index.ts`).
 *
 * `listen: false` makes `app.start()` mount every route but bind no TCP port —
 * the serverless platform owns the listener and drives the returned app's
 * `expressApp` directly. Default `true` is the normal long-running server.
 */
export async function buildApp(opts: {listen?: boolean} = {}) {
  const app = new RestApplication({rest: {listen: opts.listen ?? true}});

  app.component(MCPComponent);
  app.configure('servers.MCPServer').to({
    name: 'hello-console',
    version: '0.0.0',
    transports: {stdio: false},
  });
  app.restController(GreetingController);
  app.service(EchoTools);
  // Ensure the MCP server is instantiated/bound before the console installs
  // the MCP panel feature (which resolves it from DI).
  await app.get<MCPServer>('servers.MCPServer');

  // One call mounts the whole console: the context, API, and MCP panels behind
  // a shared shell at /console. This is a public showcase with no secrets, so
  // we allow unauthenticated access; gate with `auth` in any real deployment —
  // the console aggregates DI internals and outbound MCP connections.
  await installConsole(app, {
    title: 'hello-console',
    unsafeAllowUnauthenticated: true,
  });

  await app.start();
  return app;
}

async function main() {
  const app = await buildApp();
  const server = await app.restServer;
  console.log(`hello-console listening at ${server.url}`);
  console.log(`  Console:  ${server.url}/console/`);
  console.log(`  (panels: Context · API · MCP — switch via the sidebar)`);
}

if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
