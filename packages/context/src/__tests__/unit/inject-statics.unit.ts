// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {
  Context,
  describeInjectedArguments,
  describeInjectedProperties,
  inject,
  injectSpec,
  instantiateClass,
  resolveInjectedArguments,
  type Getter,
  type InjectStatics,
} from '../../index.js';

function givenContext(): Context {
  const ctx = new Context('test');
  ctx.bind('config.greeting').to('hello');
  ctx.bind('config.name').to('world');
  ctx.bind('rails.a').to('rail-a').tag('payment.rails');
  ctx.bind('rails.b').to('rail-b').tag('payment.rails');
  return ctx;
}

describe('static inject (constructor params)', () => {
  it('resolves bare binding keys as injectSpec.key shorthand', async () => {
    class Greeter {
      static inject = {
        params: ['config.greeting', 'config.name'],
      } satisfies InjectStatics;
      constructor(
        readonly greeting: string,
        readonly name: string,
      ) {}
    }
    const ctx = givenContext();
    const g = await instantiateClass(Greeter, ctx);
    expect(g.greeting).toBe('hello');
    expect(g.name).toBe('world');
  });

  it('resolves injectSpec.tag to an array of tagged values', async () => {
    class Payments {
      static inject = {
        params: [injectSpec.tag('payment.rails')],
      } satisfies InjectStatics;
      constructor(readonly rails: string[]) {}
    }
    const ctx = givenContext();
    const p = await instantiateClass(Payments, ctx);
    expect(p.rails.sort()).toEqual(['rail-a', 'rail-b']);
  });

  it('resolves injectSpec.getter lazily', async () => {
    class Lazy {
      static inject = {
        params: [injectSpec.getter('config.greeting')],
      } satisfies InjectStatics;
      constructor(readonly getGreeting: Getter<string>) {}
    }
    const ctx = givenContext();
    const l = await instantiateClass(Lazy, ctx);
    await expect(l.getGreeting()).resolves.toBe('hello');
  });

  it('resolves injectSpec.context to the resolution context', async () => {
    class NeedsCtx {
      static inject = {
        params: [injectSpec.context()],
      } satisfies InjectStatics;
      constructor(readonly ctx: Context) {}
    }
    const ctx = givenContext();
    const n = await instantiateClass(NeedsCtx, ctx);
    expect(n.ctx).toBe(ctx);
  });
});

describe('static inject (properties)', () => {
  it('injects properties by name', async () => {
    class WithProps {
      static inject = {
        properties: {greeting: 'config.greeting'},
      } satisfies InjectStatics;
      greeting!: string;
    }
    const ctx = givenContext();
    const w = await instantiateClass(WithProps, ctx);
    expect(w.greeting).toBe('hello');
  });
});

describe('static injectMethods (method slots)', () => {
  it('weaves injected slots around non-injected leading args', async () => {
    class Handler {
      static injectMethods = {
        handle: [undefined, 'config.name'],
      };
      handle(input: {text: string}, name: string) {
        return `${input.text}-${name}`;
      }
    }
    const ctx = givenContext();
    const args = await resolveInjectedArguments(
      Handler.prototype,
      'handle',
      ctx,
      undefined,
      [{text: 'hi'}],
    );
    const h = new Handler();
    expect(h.handle.apply(h, args as Parameters<Handler['handle']>)).toBe(
      'hi-world',
    );
  });
});

describe('mixing guard', () => {
  it('throws when static inject and @inject decorate the same constructor', () => {
    class Mixed {
      static inject = {params: ['config.greeting']} satisfies InjectStatics;
      constructor(@inject('config.name') readonly name: string) {}
    }
    expect(() => describeInjectedArguments(Mixed)).toThrow(
      /Mixed injection styles on Mixed/,
    );
  });

  it('throws when static properties and @inject properties coexist', () => {
    class MixedProps {
      static inject = {
        properties: {greeting: 'config.greeting'},
      } satisfies InjectStatics;
      @inject('config.name') name!: string;
      greeting!: string;
    }
    expect(() => describeInjectedProperties(MixedProps.prototype)).toThrow(
      /Mixed injection styles on MixedProps/,
    );
  });
});

describe('inheritance rules', () => {
  class Base {
    static inject = {params: ['config.greeting']} satisfies InjectStatics;
    constructor(readonly greeting: string) {}
  }

  it('a subclass with an implicit constructor inherits parent params', async () => {
    class Sub extends Base {}
    const ctx = givenContext();
    const s = await instantiateClass(Sub, ctx);
    expect(s.greeting).toBe('hello');
  });

  it('a subclass with its own constructor does NOT inherit params', () => {
    class SubOwnCtor extends Base {
      constructor(
        readonly extra: number,
        greeting: string,
      ) {
        super(greeting);
      }
    }
    // Inherited statics are ignored; with no own declaration there are no
    // injections at all — the arity mismatch surfaces instead of silently
    // resolving with the parent's params.
    expect(describeInjectedArguments(SubOwnCtor)).toEqual([]);
  });

  it('a subclass with its own constructor and own statics works', async () => {
    class SubDeclared extends Base {
      static inject = {
        params: ['config.name', 'config.greeting'],
      } satisfies InjectStatics;
      constructor(
        readonly name: string,
        greeting: string,
      ) {
        super(greeting);
      }
    }
    const ctx = givenContext();
    const s = await instantiateClass(SubDeclared, ctx);
    expect(s.name).toBe('world');
    expect(s.greeting).toBe('hello');
  });
});
