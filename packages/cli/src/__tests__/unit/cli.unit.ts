// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it, vi} from 'vitest';
import {main} from '../../cli.js';

describe('main', () => {
  it('prints usage and exits 0 with no args', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main([])).toBe(0);
    log.mockRestore();
  });

  it('maps a bad flag to exit 1 with a clean message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['deploy', 'vercel', '--bogus'])).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/unknown flag/i));
    err.mockRestore();
  });

  it('maps a bad flag on cloudflare to exit 1 with a clean message', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['deploy', 'cloudflare', '--bogus'])).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/unknown flag/i));
    err.mockRestore();
  });
});
