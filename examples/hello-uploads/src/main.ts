// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-uploads — first-class file upload/download on the schema-first routing.
// Routes (send `x-user-id` to identify the caller):
//   POST /files        multipart/form-data, field "file" (+ optional "label")
//   GET  /files        list your files
//   GET  /files/{id}   download (owner only)
//   GET  /openapi.json the upload route emits multipart/form-data, file=binary

import {isMain} from '@agentback/core';
import {installExplorer} from '@agentback/rest-explorer';
import {HelloUploadsApplication} from './application.js';

async function main() {
  const app = new HelloUploadsApplication();
  await installExplorer(app, {title: 'hello-uploads API'});
  await app.start();

  const server = await app.restServer;
  console.log(`hello-uploads listening at ${server.url}`);
  console.log(
    `  POST   ${server.url}/files       (multipart field "file"; header x-user-id)`,
  );
  console.log(`  GET    ${server.url}/files       (list your files)`);
  console.log(`  GET    ${server.url}/files/{id}  (download — owner only)`);
  console.log(`  GET    ${server.url}/openapi.json`);
  console.log(`  GET    ${server.url}/explorer/`);
}

if (isMain(import.meta)) void main();
