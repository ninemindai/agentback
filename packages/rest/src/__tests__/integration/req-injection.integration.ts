// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import type {Request, Response} from 'express';
import {inject} from '@agentback/core';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';
import {RestBindings} from '../../keys.js';

// No input schema → slot 0 is free for @inject. The raw request/response are
// the escape hatch for uploads/downloads/streaming.
@api({})
class RawController {
  @get('/raw')
  raw(
    @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request,
    @inject(RestBindings.HTTP_RESPONSE, {optional: true}) res?: Response,
  ) {
    res?.setHeader('x-from-res', 'yes');
    return {
      hasReq: !!req,
      hasRes: !!res,
      method: req?.method ?? null,
      probe: req?.get('x-probe') ?? null,
    };
  }

  // A route that injects nothing still works (binding is harmless when unused).
  @get('/plain')
  plain() {
    return {ok: true};
  }
}

describe('RestBindings.HTTP_REQUEST / HTTP_RESPONSE injection', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(RawController);
    await app.start();
    client = supertest((await app.restServer).url);
  });
  afterAll(async () => app.stop());

  it('injects the raw request + response into a handler', async () => {
    const res = await client.get('/raw').set('x-probe', 'hello').expect(200);
    expect(res.body).toEqual({
      hasReq: true,
      hasRes: true,
      method: 'GET',
      probe: 'hello',
    });
    expect(res.headers['x-from-res']).toBe('yes');
  });

  it('leaves routes that do not inject them unaffected', async () => {
    await client.get('/plain').expect(200, {ok: true});
  });
});
