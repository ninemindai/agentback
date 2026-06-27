// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {securityId, type UserProfile} from '@agentback/security';
import type {
  AuthRequest,
  AuthenticationResult,
} from '@agentback/authentication';
import {OAuth2AuthenticationStrategy} from '../../oauth2.strategy.js';
import type {OAuth2IntrospectionService} from '../../introspection.service.js';
import type {IntrospectionResponse} from '../../types.js';

/** Service stub that returns a canned introspection response. */
function stubService(
  response: IntrospectionResponse,
): OAuth2IntrospectionService {
  return {
    introspect: async () => response,
  } as unknown as OAuth2IntrospectionService;
}

/** Service stub that records the token it was asked to introspect. */
function recordingService(): {
  service: OAuth2IntrospectionService;
  token(): string | undefined;
} {
  let seen: string | undefined;
  const service = {
    introspect: async (t: string) => {
      seen = t;
      return {active: true, sub: 'u'} as IntrospectionResponse;
    },
  } as unknown as OAuth2IntrospectionService;
  return {service, token: () => seen};
}

function req(authorization?: string): AuthRequest {
  return {
    method: 'GET',
    headerValue: name =>
      name.toLowerCase() === 'authorization' ? authorization : undefined,
    query: {},
  };
}

describe('OAuth2AuthenticationStrategy', () => {
  it('is named "oauth2"', () => {
    expect(
      new OAuth2AuthenticationStrategy(stubService({active: true})).name,
    ).toBe('oauth2');
  });

  it('extracts the bearer token and hands it to the service', async () => {
    const {service, token} = recordingService();
    const strategy = new OAuth2AuthenticationStrategy(service);

    await strategy.authenticate(req('Bearer the-opaque-token'));

    expect(token()).toBe('the-opaque-token');
  });

  it('maps a user token (sub) to {user} with normalized scopes', async () => {
    const strategy = new OAuth2AuthenticationStrategy(
      stubService({
        active: true,
        sub: 'user-42',
        username: 'alice',
        scope: 'widgets:read widgets:write',
      }),
    );

    const result = (await strategy.authenticate(
      req('Bearer t'),
    )) as AuthenticationResult;

    expect(result.user).toBeDefined();
    expect(result.clientApplication).toBeUndefined();
    const user = result.user as UserProfile & {scopes?: string[]};
    expect(user[securityId]).toBe('user-42');
    expect(user.name).toBe('alice');
    expect(user.scopes).toEqual(['widgets:read', 'widgets:write']);
  });

  it('maps a client-credentials token (no sub) to {clientApplication} with allowedScopes', async () => {
    const strategy = new OAuth2AuthenticationStrategy(
      stubService({
        active: true,
        client_id: 'svc-billing',
        scope: 'invoices:read',
      }),
    );

    const result = (await strategy.authenticate(
      req('Bearer t'),
    )) as AuthenticationResult;

    expect(result.user).toBeUndefined();
    expect(result.clientApplication).toBeDefined();
    const app = result.clientApplication!;
    expect(app[securityId]).toBe('svc-billing');
    expect(app.allowedScopes).toEqual(['invoices:read']);
  });

  it('strips RFC 7662 framing claims from the principal', async () => {
    const strategy = new OAuth2AuthenticationStrategy(
      stubService({
        active: true,
        sub: 'u',
        exp: 1893456000,
        iat: 1893452400,
        nbf: 1893452400,
        token_type: 'Bearer',
        department: 'eng',
      }),
    );

    const result = (await strategy.authenticate(
      req('Bearer t'),
    )) as AuthenticationResult;
    const user = result.user as Record<string, unknown>;

    expect(user.active).toBeUndefined();
    expect(user.exp).toBeUndefined();
    expect(user.iat).toBeUndefined();
    expect(user.nbf).toBeUndefined();
    expect(user.token_type).toBeUndefined();
    // Non-framing custom claims survive.
    expect(user.department).toBe('eng');
  });

  it('throws 401 when the Authorization header is absent', async () => {
    const strategy = new OAuth2AuthenticationStrategy(
      stubService({active: true}),
    );
    await expect(strategy.authenticate(req())).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('throws 401 when the Authorization header is not a Bearer scheme', async () => {
    const strategy = new OAuth2AuthenticationStrategy(
      stubService({active: true}),
    );
    await expect(
      strategy.authenticate(req('Basic dXNlcjpwYXNz')),
    ).rejects.toMatchObject({statusCode: 401});
  });

  it('throws 401 when the bearer value is empty', async () => {
    const strategy = new OAuth2AuthenticationStrategy(
      stubService({active: true}),
    );
    await expect(strategy.authenticate(req('Bearer '))).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('throws 401 when the token identifies neither a user nor a client', async () => {
    const strategy = new OAuth2AuthenticationStrategy(
      stubService({active: true, scope: 'x'}),
    );
    await expect(strategy.authenticate(req('Bearer t'))).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
