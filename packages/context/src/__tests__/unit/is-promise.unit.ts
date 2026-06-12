// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {isPromiseLike} from '../../index.js';

// A minimal non-native thenable used in place of `bluebird` so isPromiseLike
// is verified against the PromiseLike contract, not just native Promise.
const customThenable = {
  then(_resolve: (value: unknown) => void) {
    /* no-op */
  },
};

describe('isPromise', () => {
  it('returns false for undefined', () => {
    expect(isPromiseLike(undefined)).toBe(false);
  });

  it('returns false for a string value', () => {
    expect(isPromiseLike('string-value')).toBe(false);
  });

  it('returns false for a plain object', () => {
    expect(isPromiseLike({foo: 'bar'})).toBe(false);
  });

  it('returns false for an array', () => {
    expect(isPromiseLike([1, 2, 3])).toBe(false);
  });

  it('returns false for a Date', () => {
    expect(isPromiseLike(new Date())).toBe(false);
  });

  it('returns true for a native Promise', () => {
    expect(isPromiseLike(Promise.resolve())).toBe(true);
  });

  it('returns true for a non-native thenable', () => {
    expect(isPromiseLike(customThenable)).toBe(true);
  });

  it('returns false when .then() is not a function', () => {
    expect(isPromiseLike({then: 'later'})).toBe(false);
  });
});
