// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {Context} from '@agentback/context';
import {MetadataInspector} from '@agentback/metadata';
import {AuthorizationKeys, AUTHORIZATION_CURRENT_TENANT} from '../../keys.js';
import {AUTHENTICATED, AuthorizationDecision, EVERYONE} from '../../types.js';
import {buildAuthorizationContext, runAuthorization} from '../../resolver.js';
import {
  authRequired,
  composeAuthDecorators,
  publicRoute,
  requireScopes,
  roleAuth,
  tenantOnly,
} from '../../decorators/presets.js';

function methodMeta(ctor: Function, method: string) {
  return MetadataInspector.getMethodMetadata(
    AuthorizationKeys.METADATA,
    ctor.prototype,
    method,
  );
}

describe('authorization presets', () => {
  it('roleAuth attaches allowedRoles + scopes', () => {
    class C {
      @roleAuth('admin', 'orders:read')
      m() {}
    }
    expect(methodMeta(C, 'm')).toEqual({
      allowedRoles: ['admin'],
      scopes: ['orders:read'],
    });
  });

  it('roleAuth accepts an array and omits scopes when none given', () => {
    class C {
      @roleAuth(['admin', 'manager'])
      m() {}
    }
    expect(methodMeta(C, 'm')).toEqual({
      allowedRoles: ['admin', 'manager'],
      scopes: undefined,
    });
  });

  it('authRequired requires the $authenticated pseudo-role', () => {
    class C {
      @authRequired()
      m() {}
    }
    expect(methodMeta(C, 'm')).toEqual({
      allowedRoles: [AUTHENTICATED],
      scopes: undefined,
    });
  });

  it('publicRoute allows everyone', () => {
    class C {
      @publicRoute()
      m() {}
    }
    expect(methodMeta(C, 'm')).toEqual({allowedRoles: [EVERYONE]});
  });

  it('requireScopes attaches scopes; .skip() bypasses', () => {
    class C {
      @requireScopes('a', 'b')
      m() {}
      @requireScopes.skip()
      n() {}
    }
    expect(methodMeta(C, 'm')).toEqual({scopes: ['a', 'b']});
    expect(methodMeta(C, 'n')).toEqual({skip: true});
  });

  it('composeAuthDecorators applies every decorator', () => {
    const calls: string[] = [];
    const mark =
      (tag: string): MethodDecorator =>
      () => {
        calls.push(tag);
      };
    class C {
      @composeAuthDecorators(mark('a'), mark('b'))
      m() {}
    }
    void C;
    expect(calls).toEqual(['a', 'b']);
  });

  describe('tenantOnly', () => {
    class C {
      @tenantOnly('t1', 't2')
      m() {}
    }
    const meta = methodMeta(C, 'm')!;

    it('ALLOWs when the bound tenant matches', async () => {
      const ctx = new Context('req');
      ctx.bind(AUTHORIZATION_CURRENT_TENANT).to({id: 't2'});
      const decision = await runAuthorization(
        buildAuthorizationContext(undefined, 'C.m'),
        meta,
        ctx,
      );
      expect(decision).toBe(AuthorizationDecision.ALLOW);
    });

    it('accepts a bare string tenant id', async () => {
      const ctx = new Context('req');
      ctx.bind(AUTHORIZATION_CURRENT_TENANT).to('t1');
      const decision = await runAuthorization(
        buildAuthorizationContext(undefined, 'C.m'),
        meta,
        ctx,
      );
      expect(decision).toBe(AuthorizationDecision.ALLOW);
    });

    it('DENYs when the tenant does not match', async () => {
      const ctx = new Context('req');
      ctx.bind(AUTHORIZATION_CURRENT_TENANT).to({id: 'other'});
      const decision = await runAuthorization(
        buildAuthorizationContext(undefined, 'C.m'),
        meta,
        ctx,
      );
      expect(decision).toBe(AuthorizationDecision.DENY);
    });

    it('DENYs when no tenant is bound (fail-closed)', async () => {
      const ctx = new Context('req');
      const decision = await runAuthorization(
        buildAuthorizationContext(undefined, 'C.m'),
        meta,
        ctx,
      );
      expect(decision).toBe(AuthorizationDecision.DENY);
    });
  });
});
