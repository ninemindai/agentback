// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeAll, expect} from 'vitest';

import {Context, inject, InvocationContext} from '../../index.js';

describe('InvocationContext', () => {
  let ctx: Context;
  let invocationCtxForGreet: InvocationContext;
  let invocationCtxForHello: InvocationContext;
  let invocationCtxForCheckName: InvocationContext;
  let invalidInvocationCtx: InvocationContext;
  let invalidInvocationCtxForStaticMethod: InvocationContext;

  beforeAll(givenContext);
  beforeAll(givenInvocationContext);

  it('has a getter for targetClass', () => {
    expect(invocationCtxForGreet.targetClass).toBe(MyController);
    expect(invocationCtxForCheckName.targetClass).toBe(MyController);
  });

  it('has a getter for targetName', () => {
    expect(invocationCtxForGreet.targetName).toBe(
      'MyController.prototype.greet',
    );
    expect(invocationCtxForCheckName.targetName).toBe('MyController.checkName');
  });

  it('has a getter for description', () => {
    expect(invocationCtxForGreet.description).toBe(
      `InvocationContext(${invocationCtxForGreet.name}): MyController.prototype.greet`,
    );
    expect(invocationCtxForCheckName.description).toBe(
      `InvocationContext(${invocationCtxForCheckName.name}): MyController.checkName`,
    );
  });

  it('has public access to parent context', () => {
    expect(invocationCtxForGreet.parent).toBe(ctx);
  });

  it('throws error if method does not exist', () => {
    expect(() => invalidInvocationCtx.assertMethodExists()).toThrow(
      'Method MyController.prototype.invalid-method not found',
    );

    expect(() =>
      invalidInvocationCtxForStaticMethod.assertMethodExists(),
    ).toThrow('Method MyController.invalid-static-method not found');
  });

  it('invokes target method', async () => {
    expect(await invocationCtxForGreet.invokeTargetMethod()).toEqual(
      'Hello, John',
    );
    expect(invocationCtxForCheckName.invokeTargetMethod()).toEqual(true);
  });

  it('invokes target method with injection', async () => {
    expect(
      await invocationCtxForHello.invokeTargetMethod({
        skipParameterInjection: false,
      }),
    ).toEqual('Hello, Jane');
  });

  it('does not close when an interceptor is in processing', () => {
    const result = invocationCtxForGreet.invokeTargetMethod();
    expect(invocationCtxForGreet.isBound('abc'));
    return result;
  });

  class MyController {
    static checkName(name: string) {
      const firstLetter = name.substring(0, 1);
      return firstLetter === firstLetter.toUpperCase();
    }

    async greet(name: string) {
      return `Hello, ${name}`;
    }

    async hello(@inject('name') name: string) {
      return `Hello, ${name}`;
    }
  }

  function givenContext() {
    ctx = new Context();
    ctx.bind('abc').to('xyz');
  }

  function givenInvocationContext() {
    invocationCtxForGreet = new InvocationContext(
      ctx,
      new MyController(),
      'greet',
      ['John'],
    );

    invocationCtxForHello = new InvocationContext(
      ctx,
      new MyController(),
      'hello',
      [],
    );
    invocationCtxForHello.bind('name').to('Jane');

    invocationCtxForCheckName = new InvocationContext(
      ctx,
      MyController,
      'checkName',
      ['John'],
    );

    invalidInvocationCtx = new InvocationContext(
      ctx,
      new MyController(),
      'invalid-method',
      ['John'],
    );

    invalidInvocationCtxForStaticMethod = new InvocationContext(
      ctx,
      MyController,
      'invalid-static-method',
      ['John'],
    );
  }
});
