// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Spawn the hello-mcp server, drive it over stdio, and verify tools work.

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {join} from 'node:path';
import {isMain} from '@agentback/core';

const serverPath = join(import.meta.dirname, 'server.js');

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
  });
  const client = new Client(
    {name: 'hello-mcp-test-client', version: '0.0.0'},
    {capabilities: {}},
  );
  await client.connect(transport);

  console.log('--- tools/list ---');
  const tools = await client.listTools();
  console.log(
    JSON.stringify(
      tools.tools.map(t => ({name: t.name, description: t.description})),
      null,
      2,
    ),
  );

  console.log('--- tools/call echo {text: "hi"} ---');
  const echo = await client.callTool({
    name: 'echo',
    arguments: {text: 'hi'},
  });
  console.log(JSON.stringify(echo.content, null, 2));

  console.log('--- tools/call add {a: 2, b: 40} ---');
  const add = await client.callTool({
    name: 'add',
    arguments: {a: 2, b: 40},
  });
  console.log(JSON.stringify(add.content, null, 2));

  console.log('--- tools/call echo {text: ""}  (should error: too short) ---');
  try {
    const bad = await client.callTool({
      name: 'echo',
      arguments: {text: ''},
    });
    console.log('result:', JSON.stringify(bad, null, 2));
  } catch (err) {
    console.log('expected error:', (err as Error).message);
  }

  await client.close();
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
