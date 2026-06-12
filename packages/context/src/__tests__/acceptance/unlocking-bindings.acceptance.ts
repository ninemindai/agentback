// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeAll, describe as context, expect} from 'vitest';

import {Binding, Context} from '../../index.js';

describe(`Context bindings - Unlocking bindings`, () => {
  describe('Unlocking a locked binding', () => {
    let ctx: Context;
    let binding: Binding;
    beforeAll(createContext);
    beforeAll(createLockedBinding);

    describe('when the binding', () => {
      context('is unlocked', () => {
        beforeAll(unlockBinding);

        it("sets it's lock state to false", () => {
          expect(binding.isLocked).toBe(false);
        });

        function unlockBinding() {
          binding.unlock();
        }
      });
    });

    describe('when the context', () => {
      context('rebinds the duplicate key with an unlocked binding', () => {
        it('does not throw a rebinding error', () => {
          const operation = () => ctx.bind('foo').to('baz');
          expect(operation).not.toThrow();
        });

        it('binds the duplicate key to the new value', async () => {
          const result = await ctx.get('foo');
          expect(result).toBe('baz');
        });
      });
    });

    function createContext() {
      ctx = new Context();
    }
    function createLockedBinding() {
      binding = ctx.bind('foo').to('bar');
      binding.lock();
    }
  });
});
