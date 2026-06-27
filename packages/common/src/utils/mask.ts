// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Mask the middle of a string for safe logging, keeping a prefix and suffix
 * visible. The number of revealed characters scales with string length:
 *
 *  - ≤4 chars  → fully masked ("****")
 *  - 5–8 chars → 1 + 1 ("a***z")
 *  - 9–16 chars → 2 + 2 ("ab*****yz")
 *  - 17–32 chars → 3 + 3
 *  - >32 chars → 4 + 4
 */
export function maskString(value: string, maskChar = '*'): string {
  const len = value.length;
  if (len <= 4) return maskChar.repeat(len);

  let reveal: number;
  if (len <= 8) reveal = 1;
  else if (len <= 16) reveal = 2;
  else if (len <= 32) reveal = 3;
  else reveal = 4;

  return (
    value.slice(0, reveal) +
    maskChar.repeat(len - reveal * 2) +
    value.slice(-reveal)
  );
}
