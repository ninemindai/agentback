// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, beforeEach} from 'vitest';
import {Context} from '@agentback/context';
import {securityId, UserProfile} from '@agentback/security';
import {MetadataInspector} from '@agentback/metadata';
import {authorize} from '../../decorators/authorize.decorator.js';
import {AuthorizationKeys} from '../../keys.js';
import {
  AUTHENTICATED,
  AuthorizationDecision,
  EVERYONE,
  UNAUTHENTICATED,
} from '../../types.js';
import {
  buildAuthorizationContext,
  defaultRoleVoter,
  getAuthorizationMetadata,
  runAuthorization,
} from '../../resolver.js';

describe('@authorize decorator', () => {
  it('attaches method-level allowedRoles', () => {
    class Ctrl {
      @authorize({allowedRoles: ['admin']})
      adminOnly() {}
    }
    const meta = MetadataInspector.getMethodMetadata(
      AuthorizationKeys.METADATA,
      Ctrl.prototype,
      'adminOnly',
    );
    expect(meta).toEqual({allowedRoles: ['admin']});
  });

  it('attaches class-level metadata as default', () => {
    @authorize({allowedRoles: ['admin']})
    class Ctrl {}
    const meta = MetadataInspector.getClassMetadata(
      AuthorizationKeys.CLASS_METADATA,
      Ctrl,
    );
    expect(meta).toEqual({allowedRoles: ['admin']});
  });

  it('.skip() opts out', () => {
    class Ctrl {
      @authorize.skip()
      open() {}
    }
    const meta = MetadataInspector.getMethodMetadata(
      AuthorizationKeys.METADATA,
      Ctrl.prototype,
      'open',
    );
    expect(meta).toEqual({skip: true});
  });

  it('.allowedRoles() shortcut', () => {
    class Ctrl {
      @authorize.allowedRoles('admin', 'editor')
      list() {}
    }
    const meta = MetadataInspector.getMethodMetadata(
      AuthorizationKeys.METADATA,
      Ctrl.prototype,
      'list',
    );
    expect(meta).toEqual({allowedRoles: ['admin', 'editor']});
  });
});

describe('getAuthorizationMetadata precedence', () => {
  it('method-level wins over class-level', () => {
    @authorize({allowedRoles: ['class-role']})
    class Ctrl {
      @authorize({allowedRoles: ['method-role']})
      foo() {}
    }
    expect(getAuthorizationMetadata(Ctrl, 'foo')).toEqual({
      allowedRoles: ['method-role'],
    });
  });

  it('falls back to class-level when no method-level decorator', () => {
    @authorize({allowedRoles: ['class-role']})
    class Ctrl {
      foo() {}
    }
    expect(getAuthorizationMetadata(Ctrl, 'foo')).toEqual({
      allowedRoles: ['class-role'],
    });
  });
});

describe('buildAuthorizationContext', () => {
  it('returns empty principals for anonymous requests', () => {
    const ctx = buildAuthorizationContext(undefined, 'Foo.bar');
    expect(ctx).toEqual({
      principals: [],
      roles: [],
      scopes: [],
      resource: 'Foo.bar',
    });
  });

  it('extracts principal id, roles, scopes from a UserProfile', () => {
    const user = {
      [securityId]: 'alice',
      name: 'alice',
      roles: ['admin'],
      scopes: ['widgets:write'],
    } as UserProfile;
    const ctx = buildAuthorizationContext(user, 'Widget.create');
    expect(ctx.principals).toEqual(['alice']);
    expect(ctx.roles).toEqual(['admin']);
    expect(ctx.scopes).toEqual(['widgets:write']);
  });

  it('splits space-separated scope strings', () => {
    const user = {
      [securityId]: 'alice',
      scopes: 'a b c',
    } as unknown as UserProfile;
    const ctx = buildAuthorizationContext(user, 'X.y');
    expect(ctx.scopes).toEqual(['a', 'b', 'c']);
  });
});

describe('defaultRoleVoter', () => {
  const meta = (overrides = {}) => ({allowedRoles: ['admin'], ...overrides});

  it('ALLOWs when the principal has an allowed role', () => {
    const ctx = buildAuthorizationContext(
      {[securityId]: 'eve', roles: ['admin']} as UserProfile,
      'X.y',
    );
    expect(defaultRoleVoter(ctx, meta())).toBe(AuthorizationDecision.ALLOW);
  });

  it('DENIes when the principal lacks every allowed role', () => {
    const ctx = buildAuthorizationContext(
      {[securityId]: 'alice', roles: ['guest']} as UserProfile,
      'X.y',
    );
    expect(defaultRoleVoter(ctx, meta())).toBe(AuthorizationDecision.DENY);
  });

  it('DENIes anonymous when allowedRoles is set', () => {
    const ctx = buildAuthorizationContext(undefined, 'X.y');
    expect(defaultRoleVoter(ctx, meta())).toBe(AuthorizationDecision.DENY);
  });

  it('honors deniedRoles even when role is in allowedRoles', () => {
    const ctx = buildAuthorizationContext(
      {[securityId]: 'eve', roles: ['admin', 'banned']} as UserProfile,
      'X.y',
    );
    const m = {allowedRoles: ['admin'], deniedRoles: ['banned']};
    expect(defaultRoleVoter(ctx, m)).toBe(AuthorizationDecision.DENY);
  });

  it('recognizes $authenticated pseudo-role', () => {
    const ctx = buildAuthorizationContext(
      {[securityId]: 'alice'} as UserProfile,
      'X.y',
    );
    expect(defaultRoleVoter(ctx, {allowedRoles: [AUTHENTICATED]})).toBe(
      AuthorizationDecision.ALLOW,
    );
  });

  it('recognizes $unauthenticated pseudo-role', () => {
    const ctx = buildAuthorizationContext(undefined, 'X.y');
    expect(defaultRoleVoter(ctx, {allowedRoles: [UNAUTHENTICATED]})).toBe(
      AuthorizationDecision.ALLOW,
    );
  });

  it('recognizes $everyone pseudo-role', () => {
    const anon = buildAuthorizationContext(undefined, 'X.y');
    const authed = buildAuthorizationContext(
      {[securityId]: 'alice'} as UserProfile,
      'X.y',
    );
    const m = {allowedRoles: [EVERYONE]};
    expect(defaultRoleVoter(anon, m)).toBe(AuthorizationDecision.ALLOW);
    expect(defaultRoleVoter(authed, m)).toBe(AuthorizationDecision.ALLOW);
  });

  it('ABSTAINs when no rules are declared', () => {
    const ctx = buildAuthorizationContext(undefined, 'X.y');
    expect(defaultRoleVoter(ctx, {})).toBe(AuthorizationDecision.ABSTAIN);
  });

  it('DENIes when required scopes are missing', () => {
    const ctx = buildAuthorizationContext(
      {[securityId]: 'eve', scopes: ['widgets:read']} as UserProfile,
      'X.y',
    );
    expect(defaultRoleVoter(ctx, {scopes: ['widgets:write']})).toBe(
      AuthorizationDecision.DENY,
    );
  });

  it('ALLOWs when all required scopes are present', () => {
    const ctx = buildAuthorizationContext(
      {[securityId]: 'eve', scopes: ['a', 'b', 'c']} as UserProfile,
      'X.y',
    );
    expect(defaultRoleVoter(ctx, {scopes: ['a', 'b']})).toBe(
      AuthorizationDecision.ALLOW,
    );
  });
});

describe('runAuthorization (voter chain)', () => {
  let ctx: Context;
  beforeEach(() => {
    ctx = new Context();
  });

  it('returns ALLOW when the default voter allows', async () => {
    const authzCtx = buildAuthorizationContext(
      {[securityId]: 'eve', roles: ['admin']} as UserProfile,
      'X.y',
    );
    const decision = await runAuthorization(
      authzCtx,
      {allowedRoles: ['admin']},
      ctx,
    );
    expect(decision).toBe(AuthorizationDecision.ALLOW);
  });

  it('first non-ABSTAIN voter wins', async () => {
    const authzCtx = buildAuthorizationContext(undefined, 'X.y');
    const inlineDeny = async () => AuthorizationDecision.DENY;
    const decision = await runAuthorization(
      authzCtx,
      {voters: [inlineDeny], allowedRoles: [EVERYONE]},
      ctx,
    );
    expect(decision).toBe(AuthorizationDecision.DENY);
  });

  it('defaults to DENY when every voter abstains', async () => {
    const authzCtx = buildAuthorizationContext(undefined, 'X.y');
    const decision = await runAuthorization(authzCtx, {}, ctx);
    expect(decision).toBe(AuthorizationDecision.DENY);
  });
});
