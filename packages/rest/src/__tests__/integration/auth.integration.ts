// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {securityId, type ClientApplication} from '@agentback/security';
import {
  authenticate,
  AuthenticationBindings,
  ClientCredentialsAuthenticationStrategy,
  type ClientCredentialsVerifier,
} from '@agentback/authentication';
import {
  authorize,
  clientAppScopeVoter,
  GLOBAL_VOTER_TAG,
} from '@agentback/authorization';
import {RestApplication} from '../../rest.application.js';

const Out = z.object({ok: z.boolean()});

@api({basePath: '/orders'})
class OrdersController {
  // Requires the client-credentials principal to hold `orders:write` AND the
  // client application to be permitted to use that scope.
  @get('/report', {response: Out})
  @authenticate('client-credentials')
  @authorize({scopes: ['orders:write']})
  async report(): Promise<z.infer<typeof Out>> {
    return {ok: true};
  }
}

// id → resolved client application (the principal). `scopes` is the user-grant
// checked by defaultRoleVoter; `allowedScopes` is the client-app governance
// checked by clientAppScopeVoter.
const apps: Record<string, ClientApplication> = {
  writer: {
    [securityId]: 'writer',
    scopes: ['orders:write'],
    allowedScopes: ['orders:write'],
  },
  // Has the user grant, but the application is NOT permitted to use it.
  governed: {
    [securityId]: 'governed',
    scopes: ['orders:write'],
    allowedScopes: ['orders:read'],
  },
};

const verifier: ClientCredentialsVerifier = (id, secret) =>
  secret === 'sekret' ? apps[id] : undefined;

describe('REST auth: client-credentials + client-app scope governance', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(OrdersController);
    app
      .bind('strategies.clientCredentials')
      .to(new ClientCredentialsAuthenticationStrategy(verifier))
      .tag(AuthenticationBindings.AUTH_STRATEGY);
    app
      .bind('voters.clientScopes')
      .to(clientAppScopeVoter)
      .tag(GLOBAL_VOTER_TAG);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('200 when the app holds and is permitted the scope', async () => {
    const r = await client
      .get('/orders/report')
      .set('client_id', 'writer')
      .set('client_secret', 'sekret')
      .expect(200);
    expect(r.body).toEqual({ok: true});
  });

  it('403 when the user grant exists but the client app forbids the scope', async () => {
    await client
      .get('/orders/report')
      .set('client_id', 'governed')
      .set('client_secret', 'sekret')
      .expect(403);
  });

  it('401 when no client credentials are provided', async () => {
    await client.get('/orders/report').expect(401);
  });

  it('401 when the client secret is wrong', async () => {
    await client
      .get('/orders/report')
      .set('client_id', 'writer')
      .set('client_secret', 'nope')
      .expect(401);
  });
});
