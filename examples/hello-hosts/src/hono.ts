// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: hello-hosts
// This file is licensed under the MIT License.

// Run: pnpm start:hono
// Hono owns the port (via @hono/node-server on Node; swap to Bun.serve / Deno.serve
// on those runtimes). AgentBack routes are delegated via hono.all('*', ...).

import {Hono} from 'hono';
import {serve} from '@hono/node-server';
import {buildApp} from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

const {host, stop} = await buildApp();

const hono = new Hono();

// Hono-native route registered first — takes precedence over the AgentBack catch-all.
hono.get('/native', c => c.json({from: 'hono'}));

// Forward everything else to the AgentBack FetchHost.
// c.req.raw is the underlying WHATWG Request, which is what fetchHandler expects.
hono.all('*', c => host.fetch(c.req.raw));

serve({fetch: hono.fetch, port: PORT}, info => {
  console.log(`\nTry:`);
  console.log(`  curl http://localhost:${info.port}/native`);
  console.log(`  curl http://localhost:${info.port}/greet/Ada`);
  console.log(`  curl -X POST http://localhost:${info.port}/echo -H 'content-type: application/json' -d '{"message":"hi"}'`);
  console.log(`  curl http://localhost:${info.port}/openapi.json\n`);
});

process.on('SIGTERM', async () => {
  await stop();
});
