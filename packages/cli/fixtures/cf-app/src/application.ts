// Copyright (c) 2024 AgentBack contributors. MIT License.

import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';

export const PingOut = z.object({pong: z.boolean()});

@api({basePath: '/ping'})
export class PingController {
  @get('/', {response: PingOut})
  async ping(): Promise<z.infer<typeof PingOut>> {
    return {pong: true};
  }
}

export async function buildApp(opts?: {listen?: boolean}): Promise<RestApplication> {
  const app = new RestApplication({rest: {listen: opts?.listen ?? false}});
  app.restController(PingController);
  await app.start();
  return app;
}
