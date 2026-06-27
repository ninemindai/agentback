// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: hello-hosts
// This file is licensed under the MIT License.

import {RestApplication, type FetchHost} from '@agentback/rest';
import {GreetController} from './controller.js';

/**
 * Build the AgentBack app and return its {@link FetchHost} without starting a
 * TCP listener (`listen: false`). The host adapter (Bun, Fastify, Hono) owns
 * the port; AgentBack owns routing + Zod validation + DI + error envelopes.
 */
export async function buildApp(): Promise<{
  host: FetchHost;
  stop(): Promise<void>;
}> {
  const app = new RestApplication({rest: {listen: false}});
  app.restController(GreetController);
  await app.start();
  const server = await app.restServer;
  return {
    host: server.fetchHandler(),
    stop: () => app.stop(),
  };
}
