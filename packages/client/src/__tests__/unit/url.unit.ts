// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {encodeQuery, expandPath, joinUrl} from '../../url.js';

describe('url helpers', () => {
  describe('expandPath', () => {
    it('substitutes a single placeholder', () => {
      expect(expandPath('/hello/{name}', {name: 'Alice'})).toBe('/hello/Alice');
    });

    it('URI-encodes special characters', () => {
      expect(expandPath('/q/{term}', {term: 'a b/c?'})).toBe('/q/a%20b%2Fc%3F');
    });

    it('throws when a placeholder value is missing', () => {
      expect(() => expandPath('/{a}/{b}', {a: 'x'})).toThrow(/Missing path/);
    });

    it('is a no-op when there are no placeholders', () => {
      expect(expandPath('/static', undefined)).toBe('/static');
    });
  });

  describe('encodeQuery', () => {
    it('returns empty string for empty input', () => {
      expect(encodeQuery({})).toBe('');
      expect(encodeQuery(undefined)).toBe('');
    });

    it('skips null and undefined values', () => {
      expect(encodeQuery({a: 1, b: undefined, c: null})).toBe('?a=1');
    });

    it('repeats keys for array values', () => {
      expect(encodeQuery({tag: ['red', 'blue']})).toBe('?tag=red&tag=blue');
    });

    it('URL-encodes values', () => {
      expect(encodeQuery({q: 'a b&c'})).toBe('?q=a+b%26c');
    });
  });

  describe('joinUrl', () => {
    it('joins with a single slash regardless of trailing/leading slashes', () => {
      expect(joinUrl('http://h:3000', '/p')).toBe('http://h:3000/p');
      expect(joinUrl('http://h:3000/', '/p')).toBe('http://h:3000/p');
      expect(joinUrl('http://h:3000/', 'p')).toBe('http://h:3000/p');
      expect(joinUrl('http://h:3000', 'p')).toBe('http://h:3000/p');
    });
  });
});
