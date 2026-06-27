// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {securityId} from '@agentback/security';
import {
  ANONYMOUS,
  principalFromAuth,
  principalFromAuthInfo,
} from '../../principal.js';

describe('principalFromAuth (REST)', () => {
  it('maps a user result to a user principal', () => {
    expect(
      principalFromAuth({user: {[securityId]: 'alice', name: 'alice'}}),
    ).toEqual({kind: 'user', id: 'alice'});
  });

  it('maps a clientApplication result to a client principal', () => {
    expect(
      principalFromAuth({clientApplication: {[securityId]: 'svc-1'}}),
    ).toEqual({kind: 'client', id: 'svc-1'});
  });

  it('is anonymous for an empty result', () => {
    expect(principalFromAuth({})).toEqual(ANONYMOUS);
    expect(principalFromAuth(undefined)).toEqual(ANONYMOUS);
  });
});

describe('principalFromAuthInfo (MCP)', () => {
  it('prefers a resolved user in extra', () => {
    expect(
      principalFromAuthInfo({
        clientId: 'app',
        extra: {user: {[securityId]: 'bob', name: 'bob'}},
      }),
    ).toEqual({kind: 'user', id: 'bob'});
  });

  it('uses a resolved clientApplication in extra', () => {
    expect(
      principalFromAuthInfo({
        extra: {clientApplication: {[securityId]: 'svc-x'}},
      }),
    ).toEqual({kind: 'client', id: 'svc-x'});
  });

  it('falls back to the OAuth2 clientId when extra has no principal', () => {
    expect(principalFromAuthInfo({clientId: 'app-42'})).toEqual({
      kind: 'client',
      id: 'app-42',
    });
  });

  it('is anonymous when nothing identifies the caller', () => {
    expect(principalFromAuthInfo(undefined)).toEqual(ANONYMOUS);
    expect(principalFromAuthInfo({})).toEqual(ANONYMOUS);
  });
});
