// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {
  DEFAULT_MAX_FILE_SIZE,
  multerFileSizeLimit,
} from '../../multipart.js';

describe('multerFileSizeLimit', () => {
  it('uses a field’s declared maxSize when set', () => {
    expect(multerFileSizeLimit([{name: 'f', options: {maxSize: 1000}}])).toBe(
      1000,
    );
  });

  it('falls back to the default for a field with no maxSize (never unbounded)', () => {
    expect(multerFileSizeLimit([{name: 'f', options: {}}])).toBe(
      DEFAULT_MAX_FILE_SIZE,
    );
  });

  it('takes the largest effective per-field limit across fields', () => {
    expect(
      multerFileSizeLimit([
        {name: 'a', options: {maxSize: 1000}},
        {name: 'b', options: {}}, // → DEFAULT, which is larger
      ]),
    ).toBe(DEFAULT_MAX_FILE_SIZE);

    expect(
      multerFileSizeLimit([
        {name: 'a', options: {maxSize: DEFAULT_MAX_FILE_SIZE * 2}},
        {name: 'b', options: {maxSize: 1000}},
      ]),
    ).toBe(DEFAULT_MAX_FILE_SIZE * 2);
  });
});
