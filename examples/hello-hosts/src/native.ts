// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: hello-hosts
// This file is licensed under the MIT License.

// Run: pnpm start:native
// The fourth option: no external host framework. `rest.listener: 'native'`
// makes RestServer.start() serve fetchHandler() through a Node http server
// directly (via createNodeListener) — the runtime-neutral Router is the single
// source of truth, the same surface Bun/Fastify/Hono drive. Experimental;
// mcp-http and raw req/res routes are unsupported in this mode.

import {RestApplication} from '@agentback/rest';
import {GreetController} from './controller.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = new RestApplication({rest: {listener: 'native', port: PORT}});
app.restController(GreetController);
await app.start();

const server = await app.restServer;
console.log(`\nNative listener on ${server.url}`);
console.log(`Try:`);
console.log(`  curl ${server.url}/greet/Ada`);
console.log(`  curl -X POST ${server.url}/echo -H 'content-type: application/json' -d '{"message":"hi"}'`);
console.log(`  curl ${server.url}/openapi.json\n`);

process.on('SIGTERM', () => void app.stop());
