// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-mcp — proves the AgentBack MCP path end-to-end over stdio.

import {z} from 'zod';
import {inject, isMain} from '@agentback/core';
import {
  MCPApplication,
  MCPBindings,
  mcpServer,
  tool,
  type Elicitor,
} from '@agentback/mcp';

const EchoInput = z.object({text: z.string().min(1).max(280)});
const AddInput = z.object({a: z.number().int(), b: z.number().int()});
const NameForm = z.object({name: z.string().min(1).describe('Your name')});

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

  // Elicitation: ask the user mid-call. The tool re-runs from the top once the
  // answer arrives, so ask before doing anything with side effects. With no
  // `input:` schema, the injected elicitor sits at slot 0.
  @tool('greet', {description: 'Asks your name, then greets you.'})
  async greet(
    @inject(MCPBindings.ELICIT) elicit: Elicitor,
  ): Promise<{greeting: string}> {
    const {name} = await elicit.ask('name', {
      message: 'What should I call you?',
      standard: NameForm,
    });
    return {greeting: `Hello, ${name}!`};
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
