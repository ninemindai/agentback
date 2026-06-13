// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-drizzle — table -> Zod -> REST route + MCP tool, one artifact chain.
// Routes/tools:
//   POST /users               (REST; body + response = drizzle-zod schemas)
//   tool create_user          (MCP; SAME input/output schemas)
//   GET  /openapi.json        (OpenAPI 3.1.1, derived from the same schemas)
//   GET  /explorer/           (Swagger UI)

import {isMain} from '@agentback/core';
import {installExplorer} from '@agentback/rest-explorer';
import {installSchemaExplorer} from '@agentback/schema-explorer';
import {HelloDrizzleApplication} from './application.js';

async function main() {
  const app = new HelloDrizzleApplication();
  await installExplorer(app, {title: 'hello-drizzle API'});
  await installSchemaExplorer(app, {title: 'hello-drizzle schemas'});
  await app.start();

  const server = await app.restServer;
  console.log(`hello-drizzle listening at ${server.url}`);
  console.log(`  REST:`);
  console.log(
    `    POST ${server.url}/users   (body: {"email":"ada@x.co","name":"Ada"})`,
  );
  console.log(`    GET  ${server.url}/openapi.json`);
  console.log(`    GET  ${server.url}/explorer/`);
  console.log(`    GET  ${server.url}/schema-explorer/  (entity provenance)`);
  console.log(`  MCP:`);
  console.log(`    tool create_user  (same NewUser/User schema chain)`);
}

if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
