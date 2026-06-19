// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// hello-actors — a shopping cart where each `cart/<id>` is an addressable,
// serialized actor, exposed over REST.
// Routes:
//   POST   /carts/{id}/items   add an item (body = AddItem; Idempotency-Key header)
//   GET    /carts/{id}         read the cart view
//   DELETE /carts/{id}         clear the cart
//   GET    /openapi.json       OpenAPI 3.1.1 derived from the Zod schemas

import {isMain} from '@agentback/core';
import {ACTOR_REGISTRY, type ActorRegistry} from '@agentback/actors';
import {installExplorer} from '@agentback/rest-explorer';
import {HelloActorsApplication} from './application.js';

async function main() {
  const app = new HelloActorsApplication();
  await installExplorer(app, {title: 'hello-actors API'});
  await app.start();

  // Subscribe to the actor event log — every checkout emits a `CheckedOut` fact.
  const registry = await app.get<ActorRegistry>(ACTOR_REGISTRY);
  registry.subscribe(({actor, event}) =>
    console.log(`  event: ${event.type} (cart/${actor.id})`, event),
  );

  const server = await app.restServer;
  console.log(`hello-actors listening at ${server.url}`);
  console.log('  REST:');
  console.log(
    `    POST   ${server.url}/carts/{id}/items   (body: {"sku":"keyboard"}; header: Idempotency-Key)`,
  );
  console.log(`    GET    ${server.url}/carts/{id}`);
  console.log(`    GET    ${server.url}/carts/{id}/total   (lease-free query)`);
  console.log(`    DELETE ${server.url}/carts/{id}`);
  console.log(
    `    POST   ${server.url}/carts/{id}/checkout (body: {"note":"…"} → priced order)`,
  );
  console.log(`    GET    ${server.url}/openapi.json`);
  console.log(`    GET    ${server.url}/explorer/`);
  console.log(
    `  Actor: @actor('cart') — in-memory runtime (swap for Redis; see README)`,
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
