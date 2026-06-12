// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {
  bind as bindDecorator,
  Binding,
  BindingScope,
  BindingScopeAndTags,
  BindingTemplate,
  bindingTemplateFor,
  Constructor,
  injectable as injectableDecorator,
  Provider,
} from '../../index.js';
import {createBindingFromClass} from '../../binding-inspector.js';

function testBindingDecorator(
  injectable: typeof injectableDecorator,
  name: '@injectable' | '@bind',
) {
  describe(name, () => {
    const expectedScopeAndTags = {
      tags: {rest: 'rest'},
      scope: BindingScope.SINGLETON,
    };

    it('decorates a class', () => {
      const spec = {
        tags: ['rest'],
        scope: BindingScope.SINGLETON,
      };

      @injectable(spec)
      class MyController {}

      expect(inspectScopeAndTags(MyController)).toEqual(expectedScopeAndTags);
    });

    it('allows inheritance for certain tags and scope', () => {
      const spec = {
        tags: ['rest'],
        scope: BindingScope.SINGLETON,
      };

      @injectable(spec)
      class MyController {}

      class MySubController extends MyController {}

      expect(inspectScopeAndTags(MySubController)).toEqual(
        expectedScopeAndTags,
      );
    });

    it('allows subclass to not have @injectable', () => {
      const spec = {
        tags: ['rest'],
        scope: BindingScope.SINGLETON,
      };

      @injectable(spec)
      class MyController {}

      class MySubController extends MyController {}
      const binding = createBindingFromClass(MySubController);
      expect(binding.source?.value).toEqual(MySubController);
    });

    it('ignores `name` and `key` from base class', () => {
      const spec = {
        tags: [
          'rest',
          {
            name: 'my-controller',
            key: 'controllers.my-controller',
          },
        ],
        scope: BindingScope.SINGLETON,
      };

      @injectable(spec)
      class MyController {}

      @injectable()
      class MySubController extends MyController {}

      const result = inspectScopeAndTags(MySubController);
      expect(result).toMatchObject(expectedScopeAndTags);
      expect(result.tags).not.toMatchObject({
        name: 'my-controller',
      });
      expect(result.tags).not.toMatchObject({
        key: 'controllers.my-controller',
      });
    });

    it('accepts template functions', () => {
      const spec: BindingTemplate = binding => {
        binding.tag('rest').inScope(BindingScope.SINGLETON);
      };

      @injectable(spec)
      class MyController {}

      expect(inspectScopeAndTags(MyController)).toEqual(expectedScopeAndTags);
    });

    it('accepts multiple scope/tags', () => {
      @injectable({tags: 'rest'}, {scope: BindingScope.SINGLETON})
      class MyController {}

      expect(inspectScopeAndTags(MyController)).toEqual(expectedScopeAndTags);
    });

    it('accepts multiple template functions', () => {
      @injectable(
        binding => binding.tag('rest'),
        binding => binding.inScope(BindingScope.SINGLETON),
      )
      class MyController {}

      expect(inspectScopeAndTags(MyController)).toEqual(expectedScopeAndTags);
    });

    it('accepts both template functions and tag/scopes', () => {
      const spec: BindingTemplate = binding => {
        binding.tag('rest').inScope(BindingScope.SINGLETON);
      };

      @injectable(spec, {tags: [{name: 'my-controller'}]})
      class MyController {}

      expect(inspectScopeAndTags(MyController)).toEqual({
        tags: {rest: 'rest', name: 'my-controller'},
        scope: BindingScope.SINGLETON,
      });
    });

    it('allows the decorator to be applied multiple times', () => {
      const spec: BindingTemplate = binding => {
        binding.tag('rest').inScope(BindingScope.SINGLETON);
      };

      @injectable(spec)
      @injectable({tags: [{name: 'my-controller'}]})
      class MyController {}

      expect(inspectScopeAndTags(MyController)).toEqual({
        tags: {rest: 'rest', name: 'my-controller'},
        scope: BindingScope.SINGLETON,
      });
    });

    it('allows the decorator to override metadata from others', () => {
      @injectable({
        scope: BindingScope.SINGLETON,
        tags: {rest: 'rest', grpc: false},
      })
      @injectable({
        scope: BindingScope.TRANSIENT,
        tags: {name: 'my-controller', grpc: true},
      })
      class MyController {}

      expect(inspectScopeAndTags(MyController)).toEqual({
        tags: {rest: 'rest', name: 'my-controller', grpc: false},
        scope: BindingScope.SINGLETON,
      });
    });

    it('decorates a provider classes', () => {
      const spec = {
        tags: ['rest'],
        scope: BindingScope.CONTEXT,
      };

      @injectable.provider(spec)
      class MyProvider implements Provider<string> {
        value() {
          return 'my-value';
        }
      }

      expect(inspectScopeAndTags(MyProvider)).toEqual({
        tags: {rest: 'rest', type: 'provider', provider: 'provider'},
        scope: BindingScope.CONTEXT,
      });
    });

    it('recognizes provider classes', () => {
      const spec = {
        tags: ['rest', {type: 'provider'}],
        scope: BindingScope.CONTEXT,
      };

      @injectable(spec)
      class MyProvider implements Provider<string> {
        value() {
          return 'my-value';
        }
      }

      expect(inspectScopeAndTags(MyProvider)).toEqual({
        tags: {rest: 'rest', type: 'provider', provider: 'provider'},
        scope: BindingScope.CONTEXT,
      });
    });

    function inspectScopeAndTags(
      cls: Constructor<unknown>,
    ): BindingScopeAndTags {
      const templateFn = bindingTemplateFor(cls);
      const bindingTemplate = new Binding('template').apply(templateFn);
      return {
        scope: bindingTemplate.scope,
        tags: bindingTemplate.tagMap,
      };
    }
  });
}

// Test @injectable
testBindingDecorator(injectableDecorator, '@injectable');

// Test @bind
testBindingDecorator(bindDecorator, '@bind');
