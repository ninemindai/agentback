// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeAll, describe as context, expect} from 'vitest';

import {Binding, Context} from '../../index.js';

describe('Context bindings - Locking bindings', () => {
  describe('Binding with a duplicate key', () => {
    let ctx: Context;
    let binding: Binding;
    beforeAll(createContext);
    beforeAll(createBinding);

    describe('when the binding', () => {
      context('is created', () => {
        it('is locked by default', () => {
          expect(binding.isLocked).toBe(false);
        });
      });

      context('is locked', () => {
        beforeAll(lockBinding);

        it("sets it's lock state to true", () => {
          expect(binding.isLocked).toBe(true);
        });

        function lockBinding() {
          binding.lock();
        }
      });
    });

    describe('when the context', () => {
      context('is binding to an existing key', () => {
        it('throws a rebind error', () => {
          const key = 'foo';
          const operation = () => ctx.bind('foo');
          expect(operation).toThrow(
            new RegExp(`Cannot rebind key "${key}" to a locked binding`),
          );
        });
      });
    });

    function createContext() {
      ctx = new Context();
    }
    function createBinding() {
      binding = ctx.bind('foo');
    }
  });
});
