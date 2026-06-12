// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {securityId, type UserProfile} from '@agentback/security';
import type {Request} from 'express';
import {ANONYMOUS_USER} from '../../types.js';
import {AnonymousAuthenticationStrategy} from '../../strategies/anonymous.strategy.js';
import {ApiKeyAuthenticationStrategy} from '../../strategies/api-key.strategy.js';

const req = (init: Partial<Request>): Request => init as Request;

describe('AnonymousAuthenticationStrategy', () => {
  it('returns the anonymous sentinel without throwing', async () => {
    const s = new AnonymousAuthenticationStrategy();
    expect(s.name).toBe('anonymous');
    const user = await s.authenticate(req({}));
    expect(user).toBe(ANONYMOUS_USER);
    expect(user?.[securityId]).toBe('$anonymous');
  });
});

describe('ApiKeyAuthenticationStrategy', () => {
  const svc: UserProfile = {[securityId]: 'svc', name: 'svc'};

  it('resolves a valid key via the verifier (header)', async () => {
    const s = new ApiKeyAuthenticationStrategy(key =>
      key === 'good' ? svc : undefined,
    );
    const user = await s.authenticate(req({headers: {'x-api-key': 'good'}}));
    expect(user).toBe(svc);
  });

  it('reads the key from the apiKey query param', async () => {
    const s = new ApiKeyAuthenticationStrategy(() => svc);
    const user = await s.authenticate(
      req({headers: {}, query: {apiKey: 'good'}}),
    );
    expect(user).toBe(svc);
  });

  it('throws when the key is missing', async () => {
    const s = new ApiKeyAuthenticationStrategy(() => svc);
    await expect(s.authenticate(req({headers: {}}))).rejects.toThrow(
      /Missing API key/,
    );
  });

  it('throws when the verifier rejects the key', async () => {
    const s = new ApiKeyAuthenticationStrategy(() => undefined);
    await expect(
      s.authenticate(req({headers: {'x-api-key': 'bad'}})),
    ).rejects.toThrow(/Invalid API key/);
  });

  it('throws when no verifier is bound', async () => {
    const s = new ApiKeyAuthenticationStrategy();
    await expect(
      s.authenticate(req({headers: {'x-api-key': 'x'}})),
    ).rejects.toThrow(/No API key verifier/);
  });
});
