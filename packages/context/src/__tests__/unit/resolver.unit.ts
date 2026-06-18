// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeAll, beforeEach, expect} from 'vitest';

import {
  BindingAddress,
  BindingScope,
  Context,
  Getter,
  inject,
  injectable,
  Injection,
  instantiateClass,
  invokeMethod,
  Provider,
  ResolutionSession,
} from '../../index.js';

describe('constructor injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').to('FOO');
    ctx.bind('bar').to('BAR');
  });

  it('resolves constructor arguments', () => {
    class TestClass {
      constructor(@inject('foo') public foo: string) {}
    }

    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.foo).toEqual('FOO');
  });

  it('allows non-injected arguments in constructor', () => {
    class TestClass {
      constructor(
        @inject('foo') public foo: string,
        public nonInjectedArg: string,
      ) {}
    }

    const theNonInjectedArg = 'BAZ';

    const test = instantiateClass(TestClass, ctx, undefined, [
      theNonInjectedArg,
    ]) as TestClass;
    expect(test.foo).toEqual('FOO');
    expect(test.nonInjectedArg).toEqual('BAZ');
  });

  it('can report error for missing binding key', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      class TestClass {
        constructor(@inject('', {x: 'bar'}) public fooBar: string) {}
      }
    }).toThrow(
      /A non-empty binding selector or resolve function is required for @inject/,
    );
  });

  it('allows optional constructor injection', () => {
    class TestClass {
      constructor(
        @inject('optional-binding-key', {optional: true})
        public fooBar: string | undefined,
      ) {}
    }

    const test = instantiateClass(TestClass, ctx) as TestClass;
    expect(test.fooBar).toBeUndefined();
  });

  it('allows optional constructor injection with default value', () => {
    class TestClass {
      constructor(
        @inject('optional-binding-key', {optional: true})
        public fooBar: string = 'fooBar',
      ) {}
    }

    const test = instantiateClass(TestClass, ctx) as TestClass;
    expect(test.fooBar).toEqual('fooBar');
  });

  it('allows optional property injection with default value', () => {
    class TestClass {
      @inject('optional-binding-key', {optional: true})
      public fooBar = 'fooBar';
    }

    const test = instantiateClass(TestClass, ctx) as TestClass;
    expect(test.fooBar).toEqual('fooBar');
  });

  it('resolves constructor arguments with custom resolve function', () => {
    class TestClass {
      constructor(
        @inject('foo', {x: 'bar'}, (c: Context, injection: Injection) => {
          const barKey = injection.metadata.x;
          const b = c.getSync(barKey);
          const f = c.getSync(injection.bindingSelector as BindingAddress);
          return f + ':' + b;
        })
        public fooBar: string,
      ) {}
    }

    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.fooBar).toEqual('FOO:BAR');
  });

  it('resolves constructor arguments with custom resolve function and no binding key', () => {
    class TestClass {
      constructor(
        @inject('', {x: 'bar'}, (c: Context, injection: Injection) => {
          const barKey = injection.metadata.x;
          const b = c.getSync(barKey);
          return 'foo' + ':' + b;
        })
        public fooBar: string,
      ) {}
    }

    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.fooBar).toEqual('foo:BAR');
  });

  it('resolves constructor arguments with custom decorator', () => {
    class TestClass {
      constructor(@customDecorator({x: 'bar'}) public fooBar: string) {}
    }

    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.fooBar).toEqual('FOO:BAR');
  });

  it('reports circular dependencies of two bindings', () => {
    const context = new Context();
    interface XInterface {}
    interface YInterface {}

    class XClass implements XInterface {
      @inject('y')
      public y: YInterface;
    }

    class YClass implements YInterface {
      @inject('x')
      public x: XInterface;
    }

    context.bind('x').toClass(XClass);
    context.bind('y').toClass(YClass);
    expect(() => context.getSync('x')).toThrow(
      'Circular dependency detected: x --> @XClass.prototype.y ' +
        '--> y --> @YClass.prototype.x --> x',
    );
    expect(() => context.getSync('y')).toThrow(
      'Circular dependency detected: y --> @YClass.prototype.x ' +
        '--> x --> @XClass.prototype.y --> y',
    );
  });

  it('allows circular dependencies of two lazy bindings', async () => {
    const context = new Context();
    interface XInterface {
      value: string;
      yVal(): Promise<string>;
    }
    interface YInterface {
      value: string;
    }

    class XClass implements XInterface {
      value = 'x';
      @inject.getter('y')
      public y: Getter<YInterface>;

      async yVal() {
        const y = await this.y();
        return y.value;
      }
    }

    class YClass implements YInterface {
      value = 'y';
      @inject.getter('x')
      public x: Getter<XInterface>;
    }

    context.bind('x').toClass(XClass);
    context.bind('y').toClass(YClass);

    const x = context.getSync<XInterface>('x');
    const y = await x.yVal();
    expect(y).toEqual('y');
  });

  // https://github.com/loopbackio/loopback-next/issues/9041
  it('uses a new session for getter resolution', async () => {
    const context = new Context();
    interface XInterface {
      value: string;
      xy(): Promise<string>;
    }
    interface YInterface {
      value: string;
    }

    @injectable({scope: BindingScope.SINGLETON})
    class XClass implements XInterface {
      value = 'x';
      @inject.getter('y')
      public y: Getter<YInterface>;

      @inject.getter('x')
      public x: Getter<XInterface>;

      async xy() {
        const y = await this.y();
        const x = await this.x();
        return x.value + y.value;
      }
    }

    @injectable({scope: BindingScope.SINGLETON})
    class YClass implements YInterface {
      value = 'y';
      @inject.getter('x')
      public x: Getter<XInterface>;
    }

    class ZClass {
      constructor(
        // Now binding x will be in the session of ZClass resolution
        @inject('x') private x: XInterface,
        @inject('y') private y: YInterface,
        @inject.getter('y') private getY: Getter<YInterface>,
      ) {}

      async test() {
        const y = await this.getY();
        expect(y.value).eql('y');
        expect(this.y.value).eql('y');
        expect(this.x.value).eql('x');
        expect(await this.x.xy()).toEqual('xy');
      }
    }

    context.bind('x').toClass(XClass);
    context.bind('y').toClass(YClass);
    context.bind('z').toClass(ZClass);

    const z = context.getSync<ZClass>('z');
    await z.test();
  });

  it('reports circular dependencies of three bindings', () => {
    const context = new Context();

    // Declare interfaces so that they can be used for typing
    interface XInterface {}
    interface YInterface {}
    interface ZInterface {}

    class XClass {
      constructor(@inject('y') public y: YInterface) {}
    }

    class YClass {
      constructor(@inject('z') public z: ZInterface) {}
    }

    class ZClass {
      constructor(@inject('x') public x: XInterface) {}
    }

    context.bind('x').toClass(XClass);
    context.bind('y').toClass(YClass);
    context.bind('z').toClass(ZClass);
    expect(() => context.getSync('x')).toThrow(
      'Circular dependency detected: x --> @XClass.constructor[0] --> y ' +
        '--> @YClass.constructor[0] --> z --> @ZClass.constructor[0] --> x',
    );
    expect(() => context.getSync('y')).toThrow(
      'Circular dependency detected: y --> @YClass.constructor[0] --> z ' +
        '--> @ZClass.constructor[0] --> x --> @XClass.constructor[0] --> y',
    );
    expect(() => context.getSync('z')).toThrow(
      'Circular dependency detected: z --> @ZClass.constructor[0] --> x ' +
        '--> @XClass.constructor[0] --> y --> @YClass.constructor[0] --> z',
    );
  });

  it('will not report circular dependencies if a binding is injected twice', () => {
    const context = new Context();
    class XClass {}

    class YClass {
      constructor(
        @inject('x') public a: XClass,
        @inject('x') public b: XClass,
      ) {}
    }

    context.bind('x').toClass(XClass);
    context.bind('y').toClass(YClass);
    const y: YClass = context.getSync('y');
    expect(y.a).toBeInstanceOf(XClass);
    expect(y.b).toBeInstanceOf(XClass);
  });

  it('tracks path of bindings', () => {
    const context = new Context();
    let bindingPath = '';
    let resolutionPath = '';

    class ZClass {
      @inject(
        'p',
        {},
        // Set up a custom resolve() to access information from the session
        (c: Context, injection: Injection, session: ResolutionSession) => {
          bindingPath = session.getBindingPath();
          resolutionPath = session.getResolutionPath();
        },
      )
      myProp: string;
    }

    class YClass {
      constructor(@inject('z') public z: ZClass) {}
    }

    class XClass {
      constructor(@inject('y') public y: YClass) {}
    }

    context.bind('x').toClass(XClass);
    context.bind('y').toClass(YClass);
    context.bind('z').toClass(ZClass);
    context.getSync('x');
    expect(bindingPath).toEqual('x --> y --> z');
    expect(resolutionPath).toEqual(
      'x --> @XClass.constructor[0] --> y --> @YClass.constructor[0]' +
        ' --> z --> @ZClass.prototype.myProp',
    );
  });

  it('tracks path of bindings for @inject.getter', async () => {
    const context = new Context();
    let bindingPath = '';
    let resolutionPath = '';
    let decorators: (string | undefined)[] = [];

    class ZClass {
      @inject(
        'p',
        {},
        // Set up a custom resolve() to access information from the session
        (c: Context, injection: Injection, session: ResolutionSession) => {
          bindingPath = session.getBindingPath();
          resolutionPath = session.getResolutionPath();
          decorators = session.injectionStack.map(i => i.metadata.decorator);
        },
      )
      myProp: string;
    }

    class YClass {
      constructor(@inject.getter('z') public z: Getter<ZClass>) {}
    }

    class XClass {
      constructor(@inject('y') public y: YClass) {}
    }

    context.bind('x').toClass(XClass);
    context.bind('y').toClass(YClass);
    context.bind('z').toClass(ZClass);
    const x: XClass = context.getSync('x');
    await x.y.z();
    expect(bindingPath).toEqual('z');
    expect(resolutionPath).toEqual('z --> @ZClass.prototype.myProp');
    expect(decorators).toEqual(['@inject']);
  });

  it('tracks path of injections', () => {
    const context = new Context();
    let injectionPath = '';

    class ZClass {
      @inject(
        'p',
        {},
        // Set up a custom resolve() to access information from the session
        (c: Context, injection: Injection, session: ResolutionSession) => {
          injectionPath = session.getInjectionPath();
        },
      )
      myProp: string;
    }

    class YClass {
      constructor(@inject('z') public z: ZClass) {}
    }

    class XClass {
      constructor(@inject('y') public y: YClass) {}
    }

    context.bind('x').toClass(XClass);
    context.bind('y').toClass(YClass);
    context.bind('z').toClass(ZClass);
    context.getSync('x');
    expect(injectionPath).toEqual(
      'XClass.constructor[0] --> YClass.constructor[0] --> ZClass.prototype.myProp',
    );
  });
});

describe('async constructor injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').toDynamicValue(() => Promise.resolve('FOO'));
    ctx.bind('bar').toDynamicValue(() => Promise.resolve('BAR'));
  });

  it('resolves constructor arguments', async () => {
    class TestClass {
      constructor(@inject('foo') public foo: string) {}
    }

    const t = await instantiateClass(TestClass, ctx);
    expect(t.foo).toEqual('FOO');
  });

  it('resolves constructor arguments with custom async decorator', async () => {
    class TestClass {
      constructor(@customAsyncDecorator({x: 'bar'}) public fooBar: string) {}
    }

    const t = await instantiateClass(TestClass, ctx);
    expect(t.fooBar).toEqual('FOO:BAR');
  });
});

describe('property injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').to('FOO');
    ctx.bind('bar').to('BAR');
  });

  it('resolves injected properties', () => {
    class TestClass {
      @inject('foo')
      foo: string;
    }
    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.foo).toEqual('FOO');
  });

  it('can report error for missing binding key', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      class TestClass {
        @inject('', {x: 'bar'})
        public fooBar: string;
      }
    }).toThrow(
      /A non-empty binding selector or resolve function is required for @inject/,
    );
  });

  it('resolves injected properties with custom resolve function', () => {
    class TestClass {
      @inject('foo', {x: 'bar'}, (c: Context, injection: Injection) => {
        const barKey = injection.metadata.x;
        const b = c.getSync(barKey);
        const f = c.getSync(injection.bindingSelector as BindingAddress);
        return f + ':' + b;
      })
      public fooBar: string;
    }

    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.fooBar).toEqual('FOO:BAR');
  });

  it('resolves inject properties with custom resolve function and no binding key', () => {
    class TestClass {
      @inject('', {x: 'bar'}, (c: Context, injection: Injection) => {
        const barKey = injection.metadata.x;
        const b = c.getSync(barKey);
        return 'foo' + ':' + b;
      })
      public fooBar: string;
    }

    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.fooBar).toEqual('foo:BAR');
  });

  it('resolves injected properties with custom decorator', () => {
    class TestClass {
      @customDecorator({x: 'bar'})
      public fooBar: string;
    }

    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.fooBar).toEqual('FOO:BAR');
  });
});

describe('async property injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').toDynamicValue(() => Promise.resolve('FOO'));
    ctx.bind('bar').toDynamicValue(() => Promise.resolve('BAR'));
  });

  it('resolves injected properties', async () => {
    class TestClass {
      @inject('foo')
      foo: string;
    }
    const t: TestClass = await instantiateClass(TestClass, ctx);
    expect(t.foo).toEqual('FOO');
  });

  it('resolves properties with custom async decorator', async () => {
    class TestClass {
      @customAsyncDecorator({x: 'bar'})
      public fooBar: string;
    }

    const t = await instantiateClass(TestClass, ctx);
    expect(t.fooBar).toEqual('FOO:BAR');
  });
});

describe('dependency injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').to('FOO');
    ctx.bind('bar').to('BAR');
  });

  it('resolves properties and constructor arguments', () => {
    class TestClass {
      @inject('bar')
      bar: string;

      constructor(@inject('foo') public foo: string) {}
    }

    const t = instantiateClass(TestClass, ctx) as TestClass;
    expect(t.foo).toEqual('FOO');
    expect(t.bar).toEqual('BAR');
  });
});

describe('async dependency injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').toDynamicValue(() => Promise.resolve('FOO'));
    ctx.bind('bar').toDynamicValue(() => Promise.resolve('BAR'));
  });

  it('resolves properties and constructor arguments', async () => {
    class TestClass {
      @inject('bar')
      bar: string;

      constructor(@inject('foo') public foo: string) {}
    }

    const t = await instantiateClass(TestClass, ctx);
    expect(t.foo).toEqual('FOO');
    expect(t.bar).toEqual('BAR');
  });
});

describe('async constructor & sync property injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').toDynamicValue(() => Promise.resolve('FOO'));
    ctx.bind('bar').to('BAR');
  });

  it('resolves properties and constructor arguments', async () => {
    class TestClass {
      @inject('bar')
      bar: string;

      constructor(@inject('foo') public foo: string) {}
    }

    const t = await instantiateClass(TestClass, ctx);
    expect(t.foo).toEqual('FOO');
    expect(t.bar).toEqual('BAR');
  });
});

describe('async constructor injection with errors', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').toDynamicValue(
      () =>
        new Promise((resolve, reject) => {
          setImmediate(() => {
            reject(new Error('foo: error'));
          });
        }),
    );
  });

  it('resolves properties and constructor arguments', async () => {
    class TestClass {
      constructor(@inject('foo') public foo: string) {}
    }

    await expect(instantiateClass(TestClass, ctx)).rejects.toThrow(
      'foo: error',
    );
  });
});

describe('async property injection with errors', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('bar').toDynamicValue(async () => {
      throw new Error('bar: error');
    });
  });

  it('resolves properties and constructor arguments', async () => {
    class TestClass {
      @inject('bar')
      bar: string;
    }

    await expect(instantiateClass(TestClass, ctx)).rejects.toThrow(
      'bar: error',
    );
  });
});

describe('sync constructor & async property injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').to('FOO');
    ctx.bind('bar').toDynamicValue(() => Promise.resolve('BAR'));
  });

  it('resolves properties and constructor arguments', async () => {
    class TestClass {
      @inject('bar')
      bar: string;

      constructor(@inject('foo') public foo: string) {}
    }

    const t = await instantiateClass(TestClass, ctx);
    expect(t.foo).toEqual('FOO');
    expect(t.bar).toEqual('BAR');
  });
});

function customDecorator(def: object) {
  return inject('foo', def, (c: Context, injection: Injection) => {
    const barKey = injection.metadata.x;
    const b = c.getSync(barKey);
    const f = c.getSync(injection.bindingSelector as BindingAddress);
    return f + ':' + b;
  });
}

function customAsyncDecorator(def: object) {
  return inject('foo', def, async (c: Context, injection: Injection) => {
    const barKey = injection.metadata.x;
    const b = await c.get(barKey);
    const f = await c.get(injection.bindingSelector as BindingAddress);
    return f + ':' + b;
  });
}

describe('method injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').to('FOO');
    ctx.bind('bar').to('BAR');
  });

  it('resolves method arguments for the prototype', () => {
    let savedInstance;
    class TestClass {
      test(@inject('foo') foo: string) {
        savedInstance = this;
        return `hello ${foo}`;
      }
    }

    const t = invokeMethod(TestClass.prototype, 'test', ctx);
    expect(savedInstance).toBe(TestClass.prototype);
    expect(t).toEqual('hello FOO');
  });

  it('resolves method arguments for a given instance', () => {
    let savedInstance;
    class TestClass {
      bar: string;

      test(@inject('foo') foo: string) {
        savedInstance = this;
        this.bar = foo;
        return `hello ${foo}`;
      }
    }

    const inst = new TestClass();
    const t = invokeMethod(inst, 'test', ctx);
    expect(savedInstance).toBe(inst);
    expect(t).toEqual('hello FOO');
    expect(inst.bar).toEqual('FOO');
  });

  it('reports error for missing binding key', () => {
    class TestClass {
      test(@inject('key-does-not-exist') fooBar: string) {}
    }

    expect(() => {
      invokeMethod(TestClass.prototype, 'test', ctx);
    }).toThrow(/The key .+ is not bound to any value/);
  });

  it('resolves arguments for a static method', () => {
    class TestClass {
      static test(@inject('foo') fooBar: string) {
        return `Hello, ${fooBar}`;
      }
    }

    const msg = invokeMethod(TestClass, 'test', ctx);
    expect(msg).toEqual('Hello, FOO');
  });
});

describe('async method injection', () => {
  let ctx: Context;

  beforeAll(function () {
    ctx = new Context();
    ctx.bind('foo').toDynamicValue(() => Promise.resolve('FOO'));
    ctx.bind('bar').toDynamicValue(() => Promise.resolve('BAR'));
  });

  it('resolves arguments for a prototype method', async () => {
    class TestClass {
      test(@inject('foo') foo: string) {
        return `hello ${foo}`;
      }
    }

    const t = await invokeMethod(TestClass.prototype, 'test', ctx);
    expect(t).toEqual('hello FOO');
  });

  it('resolves arguments for a prototype method with an instance', async () => {
    class TestClass {
      bar: string;

      test(@inject('foo') foo: string) {
        this.bar = foo;
        return `hello ${foo}`;
      }
    }

    const inst = new TestClass();
    const t = await invokeMethod(inst, 'test', ctx);
    expect(t).toEqual('hello FOO');
    expect(inst.bar).toEqual('FOO');
  });

  it('resolves arguments for a method that returns a promise', async () => {
    let savedInstance;
    class TestClass {
      bar: string;

      test(@inject('foo') foo: string) {
        savedInstance = this;
        this.bar = foo;
        return Promise.resolve(`hello ${foo}`);
      }
    }

    const inst = new TestClass();
    const t = await invokeMethod(inst, 'test', ctx);
    expect(savedInstance).toBe(inst);
    expect(t).toEqual('hello FOO');
    expect(inst.bar).toEqual('FOO');
  });
});

describe('concurrent resolutions', () => {
  let asyncCount = 0;
  let syncCount = 0;

  beforeEach(() => {
    asyncCount = 0;
    syncCount = 0;
  });

  it('returns the same value for concurrent resolutions of the same binding - CONTEXT', async () => {
    const ctx = new Context('request');

    ctx
      .bind('asyncValue')
      .toProvider(AsyncValueProvider)
      .inScope(BindingScope.CONTEXT);
    ctx
      .bind('syncValue')
      .toProvider(SyncValueProvider)
      .inScope(BindingScope.CONTEXT);
    ctx.bind('AsyncValueUser').toClass(AsyncValueUser);
    const user: AsyncValueUser = await ctx.get('AsyncValueUser');
    expect(user.asyncValue1).toEqual('async value: 0');
    expect(user.asyncValue2).toEqual('async value: 0');
    expect(user.syncValue1).toEqual('sync value: 0');
    expect(user.syncValue2).toEqual('sync value: 0');
  });

  it('returns the same value for concurrent resolutions of the same binding -  SINGLETON', async () => {
    const ctx = new Context('request');

    ctx
      .bind('asyncValue')
      .toProvider(AsyncValueProvider)
      .inScope(BindingScope.SINGLETON);
    ctx
      .bind('syncValue')
      .toProvider(SyncValueProvider)
      .inScope(BindingScope.SINGLETON);
    ctx.bind('AsyncValueUser').toClass(AsyncValueUser);
    const user: AsyncValueUser = await ctx.get('AsyncValueUser');
    expect(user.asyncValue1).toEqual('async value: 0');
    expect(user.asyncValue2).toEqual('async value: 0');
    expect(user.syncValue1).toEqual('sync value: 0');
    expect(user.syncValue2).toEqual('sync value: 0');
  });

  it('returns new values for concurrent resolutions of the same binding -  TRANSIENT', async () => {
    const ctx = new Context('request');

    ctx
      .bind('asyncValue')
      .toProvider(AsyncValueProvider)
      .inScope(BindingScope.TRANSIENT);
    ctx
      .bind('syncValue')
      .toProvider(SyncValueProvider)
      .inScope(BindingScope.TRANSIENT);
    ctx.bind('AsyncValueUser').toClass(AsyncValueUser);
    const user: AsyncValueUser = await ctx.get('AsyncValueUser');
    expect(user.asyncValue1).toEqual('async value: 0');
    expect(user.asyncValue2).toEqual('async value: 1');
    expect(user.syncValue1).toEqual('sync value: 0');
    expect(user.syncValue2).toEqual('sync value: 1');
  });

  class AsyncValueProvider implements Provider<string> {
    public value() {
      return Promise.resolve(`async value: ${asyncCount++}`);
    }
  }

  class SyncValueProvider implements Provider<string> {
    public value() {
      return `sync value: ${syncCount++}`;
    }
  }

  class AsyncValueUser {
    constructor(
      @inject('asyncValue') readonly asyncValue1: string,
      @inject('asyncValue') readonly asyncValue2: string,
      @inject('syncValue') readonly syncValue1: string,
      @inject('syncValue') readonly syncValue2: string,
    ) {}
  }
});
