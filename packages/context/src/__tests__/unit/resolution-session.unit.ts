// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeAll, beforeEach, expect} from 'vitest';

import {
  Binding,
  Context,
  inject,
  Injection,
  ResolutionSession,
} from '../../index.js';
import {ResolutionError} from '../../resolution-session.js';

describe('ResolutionSession', () => {
  class MyController {
    constructor(@inject('b') private b: string) {}
  }
  function givenInjection(): Injection {
    return {
      target: MyController,
      bindingSelector: 'b',
      methodDescriptorOrParameterIndex: 0,
      metadata: {},
    };
  }

  let session: ResolutionSession;

  beforeEach(() => {
    session = new ResolutionSession();
  });

  it('tracks bindings', () => {
    const binding = new Binding('a');
    session.pushBinding(binding);
    expect(session.currentBinding).toBe(binding);
    expect(session.bindingStack).toEqual([binding]);
    expect(session.popBinding()).toBe(binding);
  });

  it('tracks injections', () => {
    const injection: Injection = givenInjection();
    session.pushInjection(injection);
    expect(session.currentInjection).toBe(injection);
    expect(session.injectionStack).toEqual([injection]);
    expect(session.popInjection()).toBe(injection);
  });

  it('popBinding() reports error if the top element is not a binding', () => {
    const injection: Injection = givenInjection();
    session.pushInjection(injection);
    expect(session.currentBinding).toBeUndefined();
    expect(() => session.popBinding()).toThrow(
      /The top element must be a binding/,
    );
  });

  it('popInjection() reports error if the top element is not an injection', () => {
    const binding = new Binding('a');
    session.pushBinding(binding);
    expect(session.currentInjection).toBeUndefined();
    expect(() => session.popInjection()).toThrow(
      /The top element must be an injection/,
    );
  });

  it('tracks mixed bindings and injections', () => {
    const bindingA = new Binding('a');
    session.pushBinding(bindingA);
    const injection: Injection = givenInjection();
    session.pushInjection(injection);
    const bindingB = new Binding('b');
    session.pushBinding(bindingB);

    expect(session.currentBinding).toBe(bindingB);
    expect(session.bindingStack).toEqual([bindingA, bindingB]);

    expect(session.currentInjection).toBe(injection);
    expect(session.injectionStack).toEqual([injection]);
    expect(session.getBindingPath()).toEqual('a --> b');
    expect(session.getInjectionPath()).toEqual('MyController.constructor[0]');
    expect(session.getResolutionPath()).toEqual(
      'a --> @MyController.constructor[0] --> b',
    );

    expect(session.toString()).toEqual(
      'a --> @MyController.constructor[0] --> b',
    );

    expect(session.popBinding()).toBe(bindingB);
    expect(session.popInjection()).toBe(injection);
    expect(session.popBinding()).toBe(bindingA);
  });

  describe('fork()', () => {
    it('returns undefined if the current session does not exist', () => {
      expect(ResolutionSession.fork(undefined)).toBeUndefined();
    });

    it('creates a new session with the same state as the current one', () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      session1.pushInjection(injection);
      const bindingB = new Binding('b');
      session1.pushBinding(bindingB);
      const session2: ResolutionSession = ResolutionSession.fork(session1)!;
      expect(session1).not.toBe(session2);
      expect(session1.stack).not.toBe(session2.stack);
      expect(session1.stack).toEqual(session2.stack);
      const bindingC = new Binding('c');
      session2.pushBinding(bindingC);
      expect(session2.currentBinding).toBe(bindingC);
      expect(session1.currentBinding).toBe(bindingB);
    });
  });

  describe('runWithBinding()', () => {
    it('allows current session to be undefined', () => {
      const bindingA = new Binding('a');
      const val = ResolutionSession.runWithBinding(() => 'ok', bindingA);
      expect(val).toEqual('ok');
    });

    it('allows a promise to be returned', async () => {
      const bindingA = new Binding('a');
      const val = await ResolutionSession.runWithBinding(
        () => Promise.resolve('ok'),
        bindingA,
      );
      expect(val).toEqual('ok');
    });

    it('pushes/pops the binding atomically for a sync action', () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      session1.pushInjection(injection);
      const bindingB = new Binding('b');
      const val = ResolutionSession.runWithBinding(
        () => 'ok',
        bindingB,
        session1,
      );
      expect(val).toEqual('ok');
      expect(session1.bindingStack).toEqual([bindingA]);
      expect(session1.injectionStack).toEqual([injection]);
    });

    it('pushes/pops the binding atomically for a failed sync action', () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      session1.pushInjection(injection);
      const bindingB = new Binding('b');
      expect(() => {
        ResolutionSession.runWithBinding(
          () => {
            throw new Error('bad');
          },
          bindingB,
          session1,
        );
      }).toThrow('bad');

      expect(session1.bindingStack).toEqual([bindingA]);
      expect(session1.injectionStack).toEqual([injection]);
    });

    it('pushes/pops the binding atomically for an async action', async () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      session1.pushInjection(injection);
      const bindingB = new Binding('b');
      const val = await ResolutionSession.runWithBinding(
        () => Promise.resolve('ok'),
        bindingB,
        session1,
      );
      expect(val).toEqual('ok');
      expect(session1.bindingStack).toEqual([bindingA]);
      expect(session1.injectionStack).toEqual([injection]);
    });

    it('pushes/pops the binding atomically for a failed action', async () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      session1.pushInjection(injection);
      const bindingB = new Binding('b');
      const val = ResolutionSession.runWithBinding(
        () => Promise.reject(new Error('bad')),
        bindingB,
        session1,
      );
      await expect(val).rejects.toThrow('bad');
      expect(session1.bindingStack).toEqual([bindingA]);
      expect(session1.injectionStack).toEqual([injection]);
    });
  });

  describe('runWithInjection()', () => {
    it('allows current session to be undefined', () => {
      const injection = givenInjection();
      const val = ResolutionSession.runWithInjection(() => 'ok', injection);
      expect(val).toEqual('ok');
    });

    it('allows a promise to be returned', async () => {
      const injection = givenInjection();
      const val = await ResolutionSession.runWithInjection(
        () => Promise.resolve('ok'),
        injection,
      );
      expect(val).toEqual('ok');
    });

    it('pushes/pops the injection atomically for a sync action', () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      const val = ResolutionSession.runWithInjection(
        () => 'ok',
        injection,
        session1,
      );
      expect(val).toEqual('ok');
      expect(session1.bindingStack).toEqual([bindingA]);
      expect(session1.injectionStack).toEqual([]);
    });

    it('pushes/pops the injection atomically for a failed sync action', () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      expect(() => {
        ResolutionSession.runWithInjection(
          () => {
            throw new Error('bad');
          },
          injection,
          session1,
        );
      }).toThrow('bad');

      expect(session1.bindingStack).toEqual([bindingA]);
      expect(session1.injectionStack).toEqual([]);
    });

    it('pushes/pops the injection atomically for an async action', async () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      const val = await ResolutionSession.runWithInjection(
        () => Promise.resolve('ok'),
        injection,
        session1,
      );
      expect(val).toEqual('ok');
      expect(session1.bindingStack).toEqual([bindingA]);
      expect(session1.injectionStack).toEqual([]);
    });

    it('pushes/pops the injection atomically for a failed async action', async () => {
      const session1 = new ResolutionSession();
      const bindingA = new Binding('a');
      session1.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      const val = ResolutionSession.runWithInjection(
        () => Promise.reject(new Error('bad')),
        injection,
        session1,
      );
      await expect(val).rejects.toThrow('bad');
      expect(session1.bindingStack).toEqual([bindingA]);
      expect(session1.injectionStack).toEqual([]);
    });
  });

  describe('ResolutionError', () => {
    let resolutionErr: ResolutionError;

    beforeAll(givenResolutionError);

    it('includes contextual information in message', () => {
      expect(resolutionErr.message).toEqual(
        'Binding not found (context: test, binding: b, resolutionPath: ' +
          'a --> @MyController.constructor[0] --> b)',
      );
    });

    it('includes contextual information in toString()', () => {
      expect(resolutionErr.toString()).toEqual(
        'ResolutionError: Binding not found ' +
          '(context: test, binding: b, resolutionPath: ' +
          'a --> @MyController.constructor[0] --> b)',
      );
    });

    function givenResolutionError() {
      const ctx = new Context('test');
      const bindingA = new Binding('a');
      ctx.add(bindingA);
      session.pushBinding(bindingA);
      const injection: Injection = givenInjection();
      session.pushInjection(injection);
      const bindingB = new Binding('b');
      ctx.add(bindingB);
      session.pushBinding(bindingB);
      resolutionErr = new ResolutionError('Binding not found', {
        options: {session},
        context: ctx,
        binding: bindingB,
      });
      return resolutionErr;
    }
  });
});
