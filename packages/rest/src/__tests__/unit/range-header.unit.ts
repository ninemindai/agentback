// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parseRangeHeader} from '../../file-response.js';

const SIZE = 100;

describe('parseRangeHeader', () => {
  it('returns null when there is no range', () => {
    expect(parseRangeHeader(undefined, SIZE)).toBeNull();
    expect(parseRangeHeader('', SIZE)).toBeNull();
  });

  it('parses a closed range (inclusive end, clamped)', () => {
    expect(parseRangeHeader('bytes=0-49', SIZE)).toEqual({start: 0, end: 49});
    expect(parseRangeHeader('bytes=10-1000', SIZE)).toEqual({
      start: 10,
      end: 99,
    });
  });

  it('parses an open-ended range to EOF', () => {
    expect(parseRangeHeader('bytes=80-', SIZE)).toEqual({start: 80, end: 99});
  });

  it('parses a suffix range (final N bytes)', () => {
    expect(parseRangeHeader('bytes=-20', SIZE)).toEqual({start: 80, end: 99});
    // suffix larger than the object clamps to the whole object
    expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({start: 0, end: 99});
  });

  it('reports unsatisfiable when start is at/after EOF', () => {
    expect(parseRangeHeader('bytes=100-', SIZE)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=200-300', SIZE)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=0-0', 0)).toBe('unsatisfiable');
  });

  it('returns null for malformed or multi-range (→ serve whole object)', () => {
    expect(parseRangeHeader('items=0-10', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=abc', SIZE)).toBeNull();
    expect(parseRangeHeader('bytes=10-5', SIZE)).toBeNull(); // end < start
    expect(parseRangeHeader('bytes=0-10,20-30', SIZE)).toBeNull(); // multi-range
    expect(parseRangeHeader('bytes=-0', SIZE)).toBeNull(); // zero suffix
  });
});
