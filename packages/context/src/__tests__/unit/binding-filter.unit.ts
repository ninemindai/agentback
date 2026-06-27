// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';

import {
  ANY_TAG_VALUE,
  Binding,
  BindingFilter,
  BindingKey,
  filterByKey,
  filterByTag,
  includesTagValue,
  isBindingAddress,
  isBindingTagFilter,
} from '../../index.js';

const key = 'foo';

describe('BindingFilter', () => {
  let binding: Binding;
  beforeEach(givenBinding);

  describe('filterByTag', () => {
    it('accepts bindings MATCHING the provided tag name', () => {
      const filter = filterByTag('controller');
      binding.tag('controller');
      expect(filter(binding)).toBe(true);
    });

    it('rejects bindings NOT MATCHING the provided tag name', () => {
      const filter = filterByTag('controller');
      binding.tag('dataSource');
      expect(filter(binding)).toBe(false);
    });

    it('accepts bindings MATCHING the provided tag regexp', () => {
      const filter = filterByTag(/^c/);
      binding.tag('controller');
      expect(filter(binding)).toBe(true);
    });

    it('rejects bindings NOT MATCHING the provided tag regexp', () => {
      const filter = filterByTag(/^c/);
      binding.tag('dataSource');
      expect(filter(binding)).toBe(false);
    });

    it('accepts bindings MATCHING the provided tag map', () => {
      const filter = filterByTag({controller: 'my-controller'});
      binding.tag({controller: 'my-controller'});
      binding.tag({name: 'my-controller'});
      expect(filter(binding)).toBe(true);
    });

    it('accepts bindings MATCHING the provided tag map with multiple tags', () => {
      const filter = filterByTag({
        controller: 'my-controller',
        name: 'my-name',
      });
      binding.tag({controller: 'my-controller'});
      binding.tag({name: 'my-name'});
      expect(filter(binding)).toBe(true);
    });

    it('accepts bindings MATCHING the provided tag map with array values', () => {
      const filter = filterByTag({
        extensionFor: includesTagValue('greeting-service'),
        name: 'my-name',
      });
      binding.tag({
        extensionFor: ['greeting-service', 'anther-extension-point'],
      });
      binding.tag({name: 'my-name'});
      expect(filter(binding)).toBe(true);
    });

    it('rejects bindings NOT MATCHING the provided tag map with array values', () => {
      const filter = filterByTag({
        extensionFor: includesTagValue('extension-point-3'),
        name: 'my-name',
      });
      binding.tag({
        extensionFor: ['extension-point-1', 'extension-point-2'],
      });
      binding.tag({name: 'my-name'});
      expect(filter(binding)).toBe(false);
    });

    it('matches ANY_TAG_VALUE if the tag name exists', () => {
      const filter = filterByTag({
        controller: ANY_TAG_VALUE,
        name: 'my-name',
      });
      binding.tag({name: 'my-name', controller: 'MyController'});
      expect(filter(binding)).toBe(true);
    });

    it('does not match ANY_TAG_VALUE if the tag name does not exists', () => {
      const filter = filterByTag({
        controller: ANY_TAG_VALUE,
        name: 'my-name',
      });
      binding.tag({name: 'my-name'});
      expect(filter(binding)).toBe(false);
    });

    it('allows include tag value matcher - true for exact match', () => {
      const filter = filterByTag({
        controller: includesTagValue('MyController'),
        name: 'my-name',
      });
      binding.tag({name: 'my-name', controller: 'MyController'});
      expect(filter(binding)).toBe(true);
    });

    it('allows include tag value matcher - true for included match', () => {
      const filter = filterByTag({
        controller: includesTagValue('MyController'),
        name: 'my-name',
      });
      binding.tag({
        name: 'my-name',
        controller: ['MyController', 'YourController'],
      });
      expect(filter(binding)).toBe(true);
    });

    it('allows include tag value matcher - false for no match', () => {
      const filter = filterByTag({
        controller: includesTagValue('XYZController'),
        name: 'my-name',
      });
      binding.tag({
        name: 'my-name',
        controller: ['MyController', 'YourController'],
      });
      expect(filter(binding)).toBe(false);
    });

    it('rejects bindings NOT MATCHING the provided tag map', () => {
      const filter = filterByTag({controller: 'your-controller'});
      binding.tag({controller: 'my-controller'});
      binding.tag({name: 'my-controller'});
      expect(filter(binding)).toBe(false);
    });

    it('rejects bindings NOT MATCHING the provided tag map with multiple tags', () => {
      const filter = filterByTag({
        controller: 'my-controller',
        name: 'my-name',
      });
      binding.tag({controller: 'my-controller'});
      binding.tag({name: 'my-controller'});
      expect(filter(binding)).toBe(false);
    });
  });

  describe('isBindingAddress', () => {
    it('allows binding selector to be a string', () => {
      expect(isBindingAddress('controllers.MyController')).toBe(true);
    });

    it('allows binding selector to be a BindingKey', () => {
      expect(
        isBindingAddress(BindingKey.create('controllers.MyController')),
      ).toBe(true);
    });

    it('does not allow binding selector to be an object', () => {
      const filter: BindingFilter = () => true;
      expect(isBindingAddress(filter)).toBe(false);
    });

    it('allows binding selector to be a BindingKey by duck-typing', () => {
      // Please note that TypeScript checks types by duck-typing
      // See https://www.typescriptlang.org/docs/handbook/interfaces.html#introduction
      const selector: BindingKey<unknown> = {
        key: 'x',
        deepProperty: () => BindingKey.create('y'),
      };
      expect(isBindingAddress(selector)).toBe(true);
    });
  });

  describe('BindingTagFilter', () => {
    it('allows tag name as string', () => {
      const filter = filterByTag('controller');
      expect(filter.bindingTagPattern).toEqual('controller');
    });

    it('allows tag name wildcard as string', () => {
      const filter = filterByTag('controllers.*');
      expect(filter.bindingTagPattern).toEqual(/^controllers\.[^.:]*$/);
    });

    it('allows tag name as regexp', () => {
      const filter = filterByTag(/controller/);
      expect(filter.bindingTagPattern).toEqual(/controller/);
    });

    it('allows tag name as map', () => {
      const filter = filterByTag({controller: 'controller', rest: true});
      expect(filter.bindingTagPattern).toEqual({
        controller: 'controller',
        rest: true,
      });
    });
  });

  describe('isBindingTagFilter', () => {
    it('returns true for binding tag filter functions', () => {
      const filter = filterByTag('controller');
      expect(isBindingTagFilter(filter)).toBe(true);
    });

    it('returns false for binding filter functions without tag', () => {
      const filter = () => true;
      expect(isBindingTagFilter(filter)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isBindingTagFilter(undefined)).toBe(false);
    });

    it('returns false if the bindingTagPattern with wrong type', () => {
      const filter = () => true;
      filter.bindingTagPattern = true; // wrong type
      expect(isBindingTagFilter(filter)).toBe(false);
    });
  });

  describe('filterByKey', () => {
    it('accepts bindings MATCHING the provided key', () => {
      const filter = filterByKey(key);
      expect(filter(binding)).toBe(true);
    });

    it('rejects bindings NOT MATCHING the provided key', () => {
      const filter = filterByKey(`another-${key}`);
      expect(filter(binding)).toBe(false);
    });

    it('accepts bindings MATCHING the provided key regexp', () => {
      const filter = filterByKey(/f.*/);
      expect(filter(binding)).toBe(true);
    });

    it('rejects bindings NOT MATCHING the provided key regexp', () => {
      const filter = filterByKey(/^ba/);
      expect(filter(binding)).toBe(false);
    });

    it('accepts bindings MATCHING the provided filter', () => {
      const filter = filterByKey(b => b.key === key);
      expect(filter(binding)).toBe(true);
    });

    it('rejects bindings NOT MATCHING the provided filter', () => {
      const filter = filterByKey(b => b.key !== key);
      expect(filter(binding)).toBe(false);
    });
  });

  function givenBinding() {
    binding = new Binding(key);
  }
});
