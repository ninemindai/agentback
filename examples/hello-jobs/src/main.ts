// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-jobs — one Zod schema for the HTTP request body AND the job payload.
// Routes:
//   POST /emails        enqueue an email job (body = EmailJob)
//   GET  /emails/{id}   report the job's state
//   GET  /openapi.json  OpenAPI 3.1.1 (body schema = the queue payload schema)

import {isMain} from '@agentback/core';
import {installExplorer} from '@agentback/rest-explorer';
import {HelloJobsApplication} from './application.js';

async function main() {
  const app = new HelloJobsApplication();
  await installExplorer(app, {title: 'hello-jobs API'});
  await app.start();

  const server = await app.restServer;
  console.log(`hello-jobs listening at ${server.url}`);
  console.log(`  REST:`);
  console.log(
    `    POST ${server.url}/emails        (body: {"to":"a@b.co","subject":"hi"})`,
  );
  console.log(`    GET  ${server.url}/emails/{id}   (job state)`);
  console.log(`    GET  ${server.url}/openapi.json`);
  console.log(`    GET  ${server.url}/explorer/`);
  console.log(
    `  Worker: @jobProcessor(SendEmail) — in-memory queue (swap for BullMQ; see README)`,
  );
}

if (isMain(import.meta)) {
  try {
    await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
