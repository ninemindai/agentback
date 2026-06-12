// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-mcp (HTTP) — the same @tool surface over the MCP Streamable HTTP
// transport, protected by the framework's auth strategies + per-tool rate
// limiting. Contrast with server.ts, which serves the same tools over stdio.

import {z} from 'zod';
import {isMain} from '@agentback/core';
import {mcpServer, MCPComponent, tool} from '@agentback/mcp';
import {RestApplication} from '@agentback/rest';
import {installMcpHttp} from '@agentback/mcp-http';
import {
  ApiKeyAuthenticationStrategy,
  API_KEY_VERIFIER,
  AuthenticationBindings,
} from '@agentback/authentication';
import {securityId, type UserProfile} from '@agentback/security';

const EchoInput = z.object({text: z.string().min(1).max(280)});
const AddInput = z.object({a: z.number().int(), b: z.number().int()});

@mcpServer()
class HttpTools {
  @tool('echo', {
    description: 'Echoes back the text you send.',
    input: EchoInput,
  })
  async echo(
    input: z.infer<typeof EchoInput>,
  ): Promise<{echoed: string; at: string}> {
    return {echoed: input.text, at: new Date().toISOString()};
  }

  @tool('add', {description: 'Adds two integers.', input: AddInput})
  async add(input: z.infer<typeof AddInput>): Promise<{sum: number}> {
    return {sum: input.a + input.b};
  }

  // Scope-gated: only sessions whose token carries the `admin` scope see or can
  // call this tool. The api-key verifier below grants `admin` to `admin-key`.
  @tool('admin_ping', {
    description: 'Admin-only tool (requires the "admin" scope).',
    scope: 'admin',
  })
  async adminPing(): Promise<{ok: boolean}> {
    return {ok: true};
  }
}

// Demo API keys → principals with scopes. (Real apps validate against a store.)
const KEYS: Record<string, UserProfile & {scopes: string[]}> = {
  'admin-key': {[securityId]: 'admin', scopes: ['admin', 'mcp:tools']},
  'user-key': {[securityId]: 'user', scopes: ['mcp:tools']},
};

async function main() {
  const port = Number(process.env.PORT ?? 3939);
  const app = new RestApplication({});
  app.configure('servers.RestServer').to({port, host: '127.0.0.1'});
  app.component(MCPComponent);
  app.service(HttpTools);

  // Authenticate /mcp with the api-key strategy (same strategy REST uses).
  app.bind(API_KEY_VERIFIER).to((key: string) => KEYS[key]);
  app
    .bind('strategies.apiKey')
    .toClass(ApiKeyAuthenticationStrategy)
    .tag(AuthenticationBindings.AUTH_STRATEGY);

  await installMcpHttp(app, {
    // Require an api-key; the principal's scopes drive per-session tool ACL.
    strategyAuth: {strategy: 'api-key'},
    // Per-(caller, tool) limits: 30/min default, but `add` is tighter at 5/min.
    rateLimit: {
      points: 30,
      durationSecs: 60,
      perTool: {add: {points: 5, durationSecs: 60}},
    },
  });

  await app.start();
  const server = await app.restServer;
  console.log(`hello-mcp (HTTP) listening at ${server.url}`);
  console.log(`  MCP endpoint: POST/GET/DELETE ${server.url}/mcp`);
  console.log(`  Auth: send  x-api-key: <key>  (no key → 401)`);
  console.log(`    admin-key → sees echo, add, admin_ping`);
  console.log(`    user-key  → sees echo, add  (admin_ping hidden by scope)`);
  console.log(`  Rate limit: 30/min per tool per caller (add: 5/min)`);
}

if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
