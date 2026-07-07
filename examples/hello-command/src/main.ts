#!/usr/bin/env node
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {buildCli} from '@agentback/command';
import {Application} from '@agentback/core';
import {MCPComponent} from '@agentback/mcp';
import {WeatherTools} from './tools.js';

// The app factory the consumer already has (here: MCP-only — no HTTP needed to
// run tools from a terminal).
async function createApp(): Promise<Application> {
  const app = new Application();
  app.component(MCPComponent);
  app.service(WeatherTools);
  return app;
}

const app = await createApp();
// REQUIRED before invoking: lifecycle-started deps (DB pools, config, messaging)
// init in app.start(). Tool discovery works pre-start; invocation does not.
await app.start();
const run = await buildCli(app, {include: ['forecast', 'geocode']});
try {
  // Exit code carries success/failure; the result prints to stdout.
  process.exitCode = await run(process.argv.slice(2));
} finally {
  await app.stop();
}
