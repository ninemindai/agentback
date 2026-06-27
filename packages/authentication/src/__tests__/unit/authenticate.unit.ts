// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, beforeEach} from 'vitest';
import {Context} from '@agentback/context';
import {securityId} from '@agentback/security';
import {authenticate} from '../../decorators/authenticate.decorator.js';
import {AuthenticationBindings, AuthenticationKeys} from '../../keys.js';
import {getAuthenticationMetadata, resolveStrategy} from '../../resolver.js';
import {MetadataInspector} from '@agentback/metadata';

describe('@authenticate decorator', () => {
  it('attaches method-level metadata with strategy name', () => {
    class Ctrl {
      @authenticate('jwt')
      protected() {}
    }
    const meta = MetadataInspector.getMethodMetadata(
      AuthenticationKeys.METADATA,
      Ctrl.prototype,
      'protected',
    );
    expect(meta).toEqual({strategy: 'jwt'});
  });

  it('attaches options to the metadata', () => {
    class Ctrl {
      @authenticate('jwt', {realm: 'admin'})
      protected() {}
    }
    const meta = MetadataInspector.getMethodMetadata(
      AuthenticationKeys.METADATA,
      Ctrl.prototype,
      'protected',
    );
    expect(meta).toEqual({strategy: 'jwt', options: {realm: 'admin'}});
  });

  it('attaches class-level metadata as a default', () => {
    @authenticate('jwt')
    class Ctrl {}
    const meta = MetadataInspector.getClassMetadata(
      AuthenticationKeys.CLASS_METADATA,
      Ctrl,
    );
    expect(meta).toEqual({strategy: 'jwt'});
  });

  it('.skip() opts out of authentication', () => {
    class Ctrl {
      @authenticate.skip()
      public() {}
    }
    const meta = MetadataInspector.getMethodMetadata(
      AuthenticationKeys.METADATA,
      Ctrl.prototype,
      'public',
    );
    expect(meta).toEqual({strategy: '', skip: true});
  });
});

describe('getAuthenticationMetadata', () => {
  it('returns method-level metadata when present', () => {
    @authenticate('class-strategy')
    class Ctrl {
      @authenticate('method-strategy')
      foo() {}
    }
    expect(getAuthenticationMetadata(Ctrl, 'foo')).toEqual({
      strategy: 'method-strategy',
    });
  });

  it('falls back to class-level metadata', () => {
    @authenticate('class-strategy')
    class Ctrl {
      foo() {}
    }
    expect(getAuthenticationMetadata(Ctrl, 'foo')).toEqual({
      strategy: 'class-strategy',
    });
  });

  it('returns undefined when no @authenticate is present', () => {
    class Ctrl {
      foo() {}
    }
    expect(getAuthenticationMetadata(Ctrl, 'foo')).toBeUndefined();
  });
});

describe('resolveStrategy', () => {
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context();
  });

  it('finds a strategy by name from tagged bindings', async () => {
    const strategy = {
      name: 'jwt',
      async authenticate() {
        return {[securityId]: 'alice', name: 'alice'};
      },
    };
    ctx
      .bind('strategies.jwt')
      .to(strategy)
      .tag(AuthenticationBindings.AUTH_STRATEGY);
    const found = await resolveStrategy(ctx, 'jwt');
    expect(found).toBe(strategy);
  });

  it('returns undefined when no strategy matches', async () => {
    const found = await resolveStrategy(ctx, 'jwt');
    expect(found).toBeUndefined();
  });

  it('picks the right strategy when multiple are bound', async () => {
    const a = {
      name: 'jwt',
      async authenticate() {
        return undefined;
      },
    };
    const b = {
      name: 'basic',
      async authenticate() {
        return undefined;
      },
    };
    ctx.bind('s.a').to(a).tag(AuthenticationBindings.AUTH_STRATEGY);
    ctx.bind('s.b').to(b).tag(AuthenticationBindings.AUTH_STRATEGY);
    expect(await resolveStrategy(ctx, 'basic')).toBe(b);
  });
});
