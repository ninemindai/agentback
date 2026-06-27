// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-mcp — proves the AgentBack MCP path end-to-end over stdio.

import {z} from 'zod';
import {isMain} from '@agentback/core';
import {mcpServer, MCPApplication, tool} from '@agentback/mcp';

const EchoInput = z.object({text: z.string().min(1).max(280)});
const AddInput = z.object({a: z.number().int(), b: z.number().int()});

@mcpServer()
class EchoTools {
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
}

async function main() {
  const app = new MCPApplication();
  app.service(EchoTools);
  // IMPORTANT: stdio transport is enabled by default. ALL stdout writes after
  // start() must be JSON-RPC frames — log to stderr instead.
  await app.start();
  process.stderr.write('hello-mcp: stdio transport ready\n');
}

// Only boot the server when this module is the entry point — not when it's
// imported (e.g. a test importing `main`). Top-level await lets us drop the
// .catch() chain and handle failures with a plain try/catch.
if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    process.stderr.write(`error: ${err}\n`);
    process.exit(1);
  }
}
