// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get, post} from '@agentback/openapi';
import type {InjectStatics} from '@agentback/context';
import {RestApplication} from '../../rest.application.js';

const EchoIn = z.object({text: z.string().min(1)});
const EchoOut = z.object({echoed: z.string(), via: z.string()});

/**
 * A controller with ZERO parameter decorators — constructor and method
 * injection both declared via the static form. This is the shape that
 * survives a migration to TC39 standard decorators (no parameter
 * decorators) and runs under type-stripping toolchains.
 */
@api({basePath: '/statics'})
class StaticsController {
  static inject = {
    params: ['services.suffix'],
  } satisfies InjectStatics;

  static injectMethods = {
    echo: [undefined, 'services.via'],
  };

  constructor(private suffix: string) {}

  @post('/echo', {body: EchoIn, response: EchoOut})
  async echo(
    input: {body: z.infer<typeof EchoIn>},
    via: string,
  ): Promise<z.infer<typeof EchoOut>> {
    return {echoed: `${input.body.text}${this.suffix}`, via};
  }

  @get('/plain')
  async plain() {
    return {suffix: this.suffix};
  }
}

describe('static-form injection through REST dispatch (integration)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.bind('services.suffix').to('!');
    app.bind('services.via').to('static-injection');
    app.restController(StaticsController);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('constructor injection resolves via static inject', async () => {
    const r = await client.get('/statics/plain').expect(200);
    expect(r.body).toEqual({suffix: '!'});
  });

  it('method slot-1 injection resolves via static injectMethods', async () => {
    const r = await client.post('/statics/echo').send({text: 'hi'}).expect(200);
    expect(r.body).toEqual({echoed: 'hi!', via: 'static-injection'});
  });
});
