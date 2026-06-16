// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: hello-hosts
// This file is licensed under the MIT License.

// Run: pnpm start:fastify
// Fastify owns the port; AgentBack routes fall through via the wildcard fallback.
// A Fastify-native route (/native) demonstrates that it front-runs AgentBack.

import Fastify from 'fastify';
import {installFastifyHost} from '@agentback/rest';
import {buildApp} from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

const {host, stop} = await buildApp();

const fastify = Fastify({logger: {level: 'info'}});

// This Fastify-native route is served by Fastify directly — not by AgentBack.
fastify.get('/native', async () => ({from: 'fastify'}));

// Mount AgentBack as a non-greedy fallback: all unmatched paths reach it.
installFastifyHost(fastify, host);

await fastify.listen({port: PORT, host: '0.0.0.0'});
console.log(`\nTry:`);
console.log(`  curl http://localhost:${PORT}/native`);
console.log(`  curl http://localhost:${PORT}/greet/Ada`);
console.log(`  curl -X POST http://localhost:${PORT}/echo -H 'content-type: application/json' -d '{"message":"hi"}'`);
console.log(`  curl http://localhost:${PORT}/openapi.json\n`);

process.on('SIGTERM', async () => {
  await fastify.close();
  await stop();
});
