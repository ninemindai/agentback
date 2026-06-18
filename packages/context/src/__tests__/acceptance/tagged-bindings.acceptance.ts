// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeAll, describe as context, expect} from 'vitest';

import {Binding, Context} from '../../index.js';

describe('Context bindings - Tagged bindings', () => {
  let ctx: Context;
  let binding: Binding;
  beforeAll(createContext);
  beforeAll(createBinding);

  describe('tag', () => {
    context('when the binding is tagged', () => {
      beforeAll(tagBinding);

      it('has a tag name', () => {
        expect(binding.tagNames).toContainEqual('controller');
      });

      function tagBinding() {
        binding.tag('controller');
      }
    });

    context('when the binding is tagged with multiple names', () => {
      beforeAll(tagBinding);

      it('has tags', () => {
        expect(binding.tagNames).toContainEqual('controller');
        expect(binding.tagNames).toContainEqual('rest');
      });

      function tagBinding() {
        binding.tag('controller', 'rest');
      }
    });

    context('when the binding is tagged with name/value objects', () => {
      beforeAll(tagBinding);

      it('has tags', () => {
        expect(binding.tagNames).toContainEqual('controller');
        expect(binding.tagNames).toContainEqual('name');
        expect(binding.tagMap).toMatchObject({
          name: 'my-controller',
          controller: 'controller',
        });
      });

      function tagBinding() {
        binding.tag({name: 'my-controller'}, 'controller');
      }
    });
  });

  function createContext() {
    ctx = new Context();
  }
  function createBinding() {
    binding = ctx.bind('foo').to('bar');
  }
});
