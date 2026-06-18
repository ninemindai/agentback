// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {EdgeRestApplication} from '@agentback/rest';

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
}): Promise<EdgeRestApplication> {
  // EdgeRestApplication is the fetch/edge host: pinned to listener:'native', so
  // fetchHandler() is the single router and start() mounts no Express — the
  // Node-only express runtime is never reached on a Cloudflare Workers isolate.
  const app = new EdgeRestApplication({rest: {listen: opts?.listen ?? false}});
  app.restController(PingController);
  await app.start();
  return app;
}
