// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {selectMigrations, type Migration} from '../../update/migration.js';

const m = (id: string, version: string): Migration => ({
  id,
  version,
  title: id,
  detect: () => [],
});

const ALL = [m('a', '0.8.0'), m('b', '0.9.0'), m('c', '0.10.0')];

describe('selectMigrations', () => {
  it('selects the half-open window (from, to]', () => {
    expect(selectMigrations(ALL, '0.8.0', '0.10.0').map(x => x.id)).toEqual([
      'b',
      'c',
    ]);
  });

  it('excludes the from version itself', () => {
    expect(selectMigrations(ALL, '0.9.0', '0.10.0').map(x => x.id)).toEqual([
      'c',
    ]);
  });

  it('returns nothing when already current', () => {
    expect(selectMigrations(ALL, '0.10.0', '0.10.0')).toEqual([]);
  });

  it('returns nothing for a downgrade', () => {
    expect(selectMigrations(ALL, '0.10.0', '0.8.0')).toEqual([]);
  });

  it('orders by version ascending regardless of registry order', () => {
    const shuffled = [ALL[2], ALL[0], ALL[1]];
    expect(
      selectMigrations(shuffled, '0.7.0', '0.10.0').map(x => x.id),
    ).toEqual(['a', 'b', 'c']);
  });
});
