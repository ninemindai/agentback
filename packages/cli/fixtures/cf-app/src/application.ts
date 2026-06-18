// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

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

export async function buildApp(opts?: {
  listen?: boolean;
}): Promise<RestApplication> {
  // listener: 'native' makes fetchHandler() the single router — no Express
  // route mounting at start() — which is required to run on an edge isolate
  // (Cloudflare Workers): the Node-only express runtime can't load there.
  const app = new RestApplication({
    rest: {listen: opts?.listen ?? false, listener: 'native'},
  });
  app.restController(PingController);
  await app.start();
  return app;
}
