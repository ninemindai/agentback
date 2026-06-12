// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import type {Request} from 'express';
import {securityId, type UserProfile} from '@agentback/security';
import type {AuthenticationResult} from '@agentback/authentication';
import createError from 'http-errors';
import type {JWTPayload} from 'jose';
import {OAuth2JwtAuthenticationStrategy} from '../../oauth2-jwt.strategy.js';
import type {JwtAccessTokenService} from '../../jwt-access-token.service.js';

/** Service stub returning canned claims. */
function stub(payload: JWTPayload): JwtAccessTokenService {
  return {verify: async () => payload} as unknown as JwtAccessTokenService;
}

function req(authorization?: string): Request {
  return {headers: authorization ? {authorization} : {}} as Request;
}

describe('OAuth2JwtAuthenticationStrategy', () => {
  it('is named "oauth2-jwt"', () => {
    expect(new OAuth2JwtAuthenticationStrategy(stub({})).name).toBe(
      'oauth2-jwt',
    );
  });

  it('extracts the bearer token and hands it to the service', async () => {
    let seen: string | undefined;
    const service = {
      verify: async (t: string) => {
        seen = t;
        return {sub: 'u'};
      },
    } as unknown as JwtAccessTokenService;
    await new OAuth2JwtAuthenticationStrategy(service).authenticate(
      req('Bearer jwt-token-here'),
    );
    expect(seen).toBe('jwt-token-here');
  });

  it('maps a user token (sub) with a space-delimited scope string', async () => {
    const result = (await new OAuth2JwtAuthenticationStrategy(
      stub({sub: 'user-9', scope: 'widgets:read widgets:write'}),
    ).authenticate(req('Bearer t'))) as AuthenticationResult;
    const user = result.user as UserProfile & {scopes?: string[]};
    expect(user[securityId]).toBe('user-9');
    expect(user.scopes).toEqual(['widgets:read', 'widgets:write']);
  });

  it('maps the array `scp` scope form used by some issuers', async () => {
    const result = (await new OAuth2JwtAuthenticationStrategy(
      stub({sub: 'user-9', scp: ['a', 'b']}),
    ).authenticate(req('Bearer t'))) as AuthenticationResult;
    const user = result.user as UserProfile & {scopes?: string[]};
    expect(user.scopes).toEqual(['a', 'b']);
  });

  it('maps a client token (no sub) to a clientApplication', async () => {
    const result = (await new OAuth2JwtAuthenticationStrategy(
      stub({client_id: 'svc-x', scope: 'a'}),
    ).authenticate(req('Bearer t'))) as AuthenticationResult;
    expect(result.clientApplication?.[securityId]).toBe('svc-x');
    expect(result.clientApplication?.allowedScopes).toEqual(['a']);
  });

  it('throws 401 when the Authorization header is missing', async () => {
    await expect(
      new OAuth2JwtAuthenticationStrategy(stub({})).authenticate(req()),
    ).rejects.toMatchObject({statusCode: 401});
  });

  it('propagates a verification failure from the service', async () => {
    const service = {
      verify: async () => {
        throw createError(401, 'Invalid access token');
      },
    } as unknown as JwtAccessTokenService;
    await expect(
      new OAuth2JwtAuthenticationStrategy(service).authenticate(
        req('Bearer t'),
      ),
    ).rejects.toMatchObject({statusCode: 401});
  });
});
