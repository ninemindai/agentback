// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {
  securityId,
  SecurityBindings,
  type UserProfile,
} from '@agentback/security';
import {
  API_KEY_VERIFIER,
  ApiKeyAuthenticationStrategy,
  AuthenticationBindings,
  authenticate,
  type ApiKeyVerifier,
} from '@agentback/authentication';
import {authorize} from '@agentback/authorization';
import {inject} from '@agentback/context';
import {RestApplication} from '../../rest.application.js';
import type {FetchHost} from '../../host/fetch.js';

// Parity arbiter for C1: authentication + authorization on the runtime-neutral
// Web dispatch path (RestHandler) must produce byte-identical results to the
// Express path. Both surfaces share ONE DI graph (an Application IS a Context),
// the SAME api-key strategy + verifier, and the SAME `@authenticate`/`@authorize`
// metadata on one controller — so any divergence is a real regression.

const Out = z.object({ok: z.boolean(), who: z.string()});

const KEYS: Record<string, UserProfile & {scopes: string[]}> = {
  'admin-key': {[securityId]: 'admin', name: 'admin', scopes: ['reports:read']},
  'plain-key': {[securityId]: 'plain', name: 'plain', scopes: []},
};

const verifier: ApiKeyVerifier = key => KEYS[key];

@api({basePath: '/secure'})
class SecureController {
  // Authenticated route: any valid api key passes. The handler reads the
  // principal from the per-request context to prove it was bound.
  @get('/whoami', {response: Out})
  @authenticate('api-key')
  async whoami(
    @inject(SecurityBindings.USER) user: UserProfile,
  ): Promise<z.infer<typeof Out>> {
    return {ok: true, who: user.name ?? 'unknown'};
  }

  // Authorized route: needs both a valid api key AND the `reports:read` scope
  // grant on the principal (checked by the default role voter).
  @get('/report', {response: Out})
  @authenticate('api-key')
  @authorize({scopes: ['reports:read']})
  async report(
    @inject(SecurityBindings.USER) user: UserProfile,
  ): Promise<z.infer<typeof Out>> {
    return {ok: true, who: user.name ?? 'unknown'};
  }
}

describe('Express<->Web auth parity (authenticate + authorize)', () => {
  let app: RestApplication;
  let http: ReturnType<typeof supertest>;
  let web: FetchHost;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(SecureController);
    app.bind(API_KEY_VERIFIER).to(verifier);
    app
      .bind('strategies.apiKey')
      .toClass(ApiKeyAuthenticationStrategy)
      .tag(AuthenticationBindings.AUTH_STRATEGY);
    await app.start();
    const server = await app.restServer;
    http = supertest(server.url);
    web = server.fetchHandler();
  });

  afterAll(async () => {
    await app.stop();
  });

  // Drive a path through BOTH surfaces and assert status + parsed body match.
  async function both(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{status: number; body: unknown}> {
    const r1 = await http.get(path).set(headers);
    const r2 = await web.fetch(new Request(`http://x${path}`, {headers}));
    const b2 = await r2.json();
    expect(r2.status).toBe(r1.status);
    expect(b2).toEqual(r1.body);
    return {status: r1.status, body: r1.body};
  }

  it('401 with identical envelope when no key is provided', async () => {
    const {status, body} = await both('/secure/whoami');
    expect(status).toBe(401);
    expect((body as {error?: unknown}).error).toBeDefined();
  });

  it('401 with identical envelope when the key is invalid', async () => {
    const {status} = await both('/secure/whoami', {'x-api-key': 'nope'});
    expect(status).toBe(401);
  });

  it('200 + identical body + bound principal when the key is valid', async () => {
    const {status, body} = await both('/secure/whoami', {
      'x-api-key': 'admin-key',
    });
    expect(status).toBe(200);
    // The handler saw the SecurityBindings.USER principal on both surfaces.
    expect(body).toEqual({ok: true, who: 'admin'});
  });

  it('200 on the @authorize route when the principal holds the scope', async () => {
    const {status, body} = await both('/secure/report', {
      'x-api-key': 'admin-key',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ok: true, who: 'admin'});
  });

  it('403 with identical envelope when the principal lacks the scope', async () => {
    const {status} = await both('/secure/report', {'x-api-key': 'plain-key'});
    expect(status).toBe(403);
  });

  it('401 on the @authorize route when unauthenticated (auth precedes authz)', async () => {
    const {status} = await both('/secure/report');
    expect(status).toBe(401);
  });
});
