// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: hello-hosts
// This file is licensed under the MIT License.

/// <reference types="bun" />
// Run: bun run src/bun.ts  (NOT compiled by tsc — Bun runs TypeScript natively)
// Bun.serve is the most direct mapping: its `fetch` field IS the FetchHost interface.

import {buildApp} from './app.js';

const PORT = Number(process.env.PORT ?? 3000);

const {host, stop} = await buildApp();

// Bun.serve's fetch field takes `(req: Request) => Response | Promise<Response>`,
// which is exactly what FetchHost.fetch provides — no adapter layer needed.
Bun.serve({
  port: PORT,
  fetch: host.fetch,
});

console.log(`\nTry:`);
console.log(`  curl http://localhost:${PORT}/greet/Ada`);
console.log(`  curl -X POST http://localhost:${PORT}/echo -H 'content-type: application/json' -d '{"message":"hi"}'`);
console.log(`  curl http://localhost:${PORT}/openapi.json\n`);

process.on('SIGTERM', async () => {
  await stop();
});
