// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {customAlphabet} from 'nanoid';
import {getEnvVarAsNumber} from './env.js';

const alphaNumeric =
  'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';

function slugSize(size?: number) {
  size = size ?? getEnvVarAsNumber('ID_SLUG_SIZE', 21)!;
  if (size <= 5) {
    // ~5 hours needed, in order to have a 1% probability of at least one collision.
    size = 5;
  } else if (size >= 36) {
    size = 36;
  }
  return size;
}

/**
 * Generate a new nano id (https://github.com/ai/nanoid)
 * @param size - Size of the id
 * @param chars - Valid characters
 */
export function generateIdSync(size?: number, chars = alphaNumeric) {
  return customAlphabet(chars, slugSize(size))();
}

/**
 * Generate a new nano id (https://github.com/ai/nanoid)
 * @param size - Size of the id
 * @param chars - Valid characters
 */
export function generateSlug(size?: number, chars = alphaNumeric) {
  size = slugSize(size);
  const slug = customAlphabet(chars, size)();
  return {
    slug,
    size,
  };
}
