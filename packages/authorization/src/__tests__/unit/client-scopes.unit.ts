// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Context} from '@agentback/context';
import {
  SecurityBindings,
  securityId,
  type ClientApplication,
} from '@agentback/security';
import {AuthorizationDecision} from '../../types.js';
import {buildAuthorizationContext, runAuthorization} from '../../resolver.js';
import {
  areScopesAllowed,
  clientAppScopeVoter,
  SCOPE_ALL,
  SCOPE_INTERNAL,
  SCOPE_PUBLIC,
} from '../../client-scopes.js';

const app = (over: Partial<ClientApplication>): ClientApplication => ({
  [securityId]: 'app-1',
  ...over,
});

describe('areScopesAllowed', () => {
  it('allows when no scopes are requested', () => {
    expect(areScopesAllowed(app({allowedScopes: []}), [])).toBe(true);
  });

  it('allows PUBLIC-only requests regardless of the app', () => {
    expect(areScopesAllowed(app({allowedScopes: []}), [SCOPE_PUBLIC])).toBe(
      true,
    );
  });

  it('allows when no client app is bound (user-only endpoint)', () => {
    expect(areScopesAllowed(undefined, ['orders:read'])).toBe(true);
  });

  it('allows by default (no allowedScopes ⇒ ALL)', () => {
    expect(areScopesAllowed(app({}), ['orders:read'])).toBe(true);
  });

  it('allows when allowedScopes contains ALL', () => {
    expect(
      areScopesAllowed(app({allowedScopes: [SCOPE_ALL]}), ['x', 'y']),
    ).toBe(true);
  });

  it('allows only listed scopes when allowedScopes is explicit', () => {
    const a = app({allowedScopes: ['orders:read']});
    expect(areScopesAllowed(a, ['orders:read'])).toBe(true);
    expect(areScopesAllowed(a, ['orders:write'])).toBe(false);
  });

  it('denies a scope listed in disallowedScopes (precedence over allow)', () => {
    const a = app({
      allowedScopes: [SCOPE_ALL],
      disallowedScopes: ['orders:delete'],
    });
    expect(areScopesAllowed(a, ['orders:delete'])).toBe(false);
    expect(areScopesAllowed(a, ['orders:read'])).toBe(true);
  });

  it('denies everything when disallowedScopes contains ALL', () => {
    const a = app({allowedScopes: [SCOPE_ALL], disallowedScopes: [SCOPE_ALL]});
    expect(areScopesAllowed(a, ['anything'])).toBe(false);
  });

  it('grants INTERNAL only when explicitly allowed (ALL does not grant it)', () => {
    expect(
      areScopesAllowed(app({allowedScopes: [SCOPE_ALL]}), [SCOPE_INTERNAL]),
    ).toBe(false);
    expect(
      areScopesAllowed(app({allowedScopes: [SCOPE_INTERNAL]}), [
        SCOPE_INTERNAL,
      ]),
    ).toBe(true);
  });
});

describe('clientAppScopeVoter', () => {
  const meta = {scopes: ['orders:write']};

  async function vote(clientApp?: ClientApplication) {
    const ctx = new Context('req');
    if (clientApp) ctx.bind(SecurityBindings.CLIENT_APPLICATION).to(clientApp);
    // Route via runAuthorization so the voter receives the invocationContext.
    return runAuthorization(
      buildAuthorizationContext(undefined, 'C.m'),
      {
        ...meta,
        voters: [clientAppScopeVoter],
      },
      ctx,
    );
  }

  it('ABSTAINs (no decision) when no client app is bound → falls to DENY default', async () => {
    // Only the client-app voter + defaultRoleVoter run; with no roles/scopes
    // matched and no app, defaultRoleVoter denies. Assert it is not ALLOW.
    expect(await vote(undefined)).not.toBe(AuthorizationDecision.ALLOW);
  });

  it('DENYs when the client app forbids the scope', async () => {
    const a = app({allowedScopes: ['orders:read']});
    expect(await vote(a)).toBe(AuthorizationDecision.DENY);
  });

  it('does not DENY at the client-app gate when the scope is permitted', async () => {
    const a = app({allowedScopes: ['orders:write']});
    // The gate ABSTAINs; final decision comes from defaultRoleVoter (which here
    // denies for lack of user scope) — so assert the gate itself did not DENY by
    // checking a permissive app with a user that has the scope ALLOWs.
    const ctx = new Context('req');
    ctx.bind(SecurityBindings.CLIENT_APPLICATION).to(a);
    const user = {[securityId]: 'u1', scopes: ['orders:write']} as never;
    const decision = await runAuthorization(
      buildAuthorizationContext(user, 'C.m'),
      {...meta, voters: [clientAppScopeVoter]},
      ctx,
    );
    expect(decision).toBe(AuthorizationDecision.ALLOW);
  });
});
