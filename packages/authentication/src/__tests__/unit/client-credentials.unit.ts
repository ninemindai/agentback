// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {
  securityId,
  type ClientApplication,
  type UserProfile,
} from '@agentback/security';
import type {Request} from 'express';
import {ClientCredentialsAuthenticationStrategy} from '../../strategies/client-credentials.strategy.js';
import {normalizeAuthResult} from '../../resolver.js';

const req = (init: Partial<Request>): Request => init as Request;
const app: ClientApplication = {
  [securityId]: 'app-1',
  name: 'Partner',
  allowedScopes: ['orders:read'],
};

describe('ClientCredentialsAuthenticationStrategy', () => {
  it('resolves credentials from headers to a client application', async () => {
    const s = new ClientCredentialsAuthenticationStrategy((id, secret) =>
      id === 'cid' && secret === 'csecret' ? app : undefined,
    );
    const result = await s.authenticate(
      req({headers: {client_id: 'cid', client_secret: 'csecret'}}),
    );
    expect(result.clientApplication).toBe(app);
    expect(result.user).toBe(app); // the application is the principal
  });

  it('resolves credentials from HTTP Basic auth', async () => {
    const basic = 'Basic ' + Buffer.from('cid:csecret').toString('base64');
    const s = new ClientCredentialsAuthenticationStrategy((id, secret) =>
      id === 'cid' && secret === 'csecret' ? app : undefined,
    );
    const result = await s.authenticate(req({headers: {authorization: basic}}));
    expect(result.clientApplication).toBe(app);
  });

  it('throws when credentials are missing', async () => {
    const s = new ClientCredentialsAuthenticationStrategy(() => app);
    await expect(s.authenticate(req({headers: {}}))).rejects.toThrow(
      /Missing client credentials/,
    );
  });

  it('throws when the verifier rejects the credentials', async () => {
    const s = new ClientCredentialsAuthenticationStrategy(() => undefined);
    await expect(
      s.authenticate(req({headers: {client_id: 'x', client_secret: 'y'}})),
    ).rejects.toThrow(/Invalid client credentials/);
  });

  it('throws when no verifier is bound', async () => {
    const s = new ClientCredentialsAuthenticationStrategy();
    await expect(
      s.authenticate(req({headers: {client_id: 'x', client_secret: 'y'}})),
    ).rejects.toThrow(/No client-credentials verifier/);
  });
});

describe('normalizeAuthResult', () => {
  it('wraps a bare UserProfile as {user}', () => {
    const user: UserProfile = {[securityId]: 'u1', name: 'alice'};
    expect(normalizeAuthResult(user)).toEqual({user});
  });

  it('passes an AuthenticationResult through unchanged', () => {
    const result = {user: {[securityId]: 'u1'}, clientApplication: app};
    expect(normalizeAuthResult(result)).toBe(result);
  });

  it('maps undefined to an empty result', () => {
    expect(normalizeAuthResult(undefined)).toEqual({});
  });
});
