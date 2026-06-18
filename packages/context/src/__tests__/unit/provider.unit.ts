// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, beforeEach, expect} from 'vitest';

import {Provider} from '../../index.js';

describe('Provider', () => {
  let provider: Provider<string>;

  beforeEach(givenProvider);

  describe('value()', () => {
    it('returns the value of the binding', () => {
      expect(provider.value()).toBe('hello world');
    });
  });

  function givenProvider() {
    provider = new MyProvider('hello');
  }
});

class MyProvider implements Provider<string> {
  constructor(private _msg: string) {}
  value(): string {
    return this._msg + ' world';
  }
}
