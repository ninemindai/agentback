// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {sortListOfGroups} from '../../index.js';

describe('sortGroups', () => {
  it('sorts groups across lists', () => {
    const result = sortListOfGroups(['first', 'end'], ['start', 'end', 'last']);
    expect(result).toEqual(['first', 'start', 'end', 'last']);
  });

  it('add new groups after existing groups', () => {
    const result = sortListOfGroups(
      ['initial', 'session', 'auth'],
      ['initial', 'added', 'auth'],
    );
    expect(result).toEqual(['initial', 'session', 'added', 'auth']);
  });

  it('merges arrays preserving the order', () => {
    const target = ['initial', 'session', 'auth', 'routes', 'files', 'final'];
    const result = sortListOfGroups(target, [
      'initial',
      'postinit',
      'preauth', // add
      'auth',
      'routes',
      'subapps', // add
      'final',
      'last', // add
    ]);

    expect(result).toEqual([
      'initial',
      'session',
      'postinit',
      'preauth',
      'auth',
      'routes',
      'files',
      'subapps',
      'final',
      'last',
    ]);
  });

  it('throws on conflicting order', () => {
    expect(() => {
      sortListOfGroups(['one', 'two'], ['two', 'one']);
    }).toThrow(/Cyclic dependency/);
  });
});
