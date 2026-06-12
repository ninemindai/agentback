// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {BindingKey} from '../../index.js';
import {UNIQUE_ID_PATTERN} from '../../unique-id.js';

describe('BindingKey', () => {
  describe('create', () => {
    it('creates a key with a binding key only', () => {
      expect(BindingKey.create('foo')).toMatchObject({
        key: 'foo',
        propertyPath: undefined,
      });
    });

    it('creates a key with a binding key and a property path', () => {
      expect(BindingKey.create('foo', 'port')).toMatchObject({
        key: 'foo',
        propertyPath: 'port',
      });
    });

    it('creates a key with a property path parsed from the key arg', () => {
      const keyString = BindingKey.create('foo', 'port').toString();
      expect(BindingKey.create(keyString)).toMatchObject({
        key: 'foo',
        propertyPath: 'port',
      });
    });

    it('rejects a key with an encoded path when the path arg is provided', () => {
      expect(() => BindingKey.create('foo#port', 'port')).toThrow(
        /Binding key.*cannot contain/,
      );
    });
  });

  describe('buildKeyWithPath', () => {
    it('composes address parts using correct separator', () => {
      expect(BindingKey.create('foo', 'bar').toString()).toBe('foo#bar');
    });
  });

  describe('parseKeyWithPath', () => {
    it('parses key without path', () => {
      expect(BindingKey.parseKeyWithPath('foo')).toMatchObject({
        key: 'foo',
        propertyPath: undefined,
      });
    });

    it('parses key with path', () => {
      expect(BindingKey.parseKeyWithPath('foo#bar')).toMatchObject({
        key: 'foo',
        propertyPath: 'bar',
      });
    });
  });

  describe('generate', () => {
    it('generates binding key without namespace', () => {
      const key1 = BindingKey.generate().key;
      expect(key1).toMatch(new RegExp(`^${UNIQUE_ID_PATTERN.source}$`));
      const key2 = BindingKey.generate().key;
      expect(key1).not.toEqual(key2);
    });

    it('generates binding key with namespace', () => {
      const key1 = BindingKey.generate('services').key;
      expect(key1).toMatch(
        new RegExp(`^services\\.${UNIQUE_ID_PATTERN.source}$`),
      );
      const key2 = BindingKey.generate('services').key;
      expect(key1).not.toEqual(key2);
    });
  });
});
