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

  it('prints the bare version for --version and -v', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const flag of ['--version', '-v']) {
      expect(await main([flag])).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/));
    }
    log.mockRestore();
  });

  it('routes `new` and surfaces its arg errors as exit 1', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['new'])).toBe(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringMatching(/npm create agentback/),
    );
    err.mockRestore();
  });

  it('exits 1 on an unknown subcommand', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['bogus'])).toBe(1);
    log.mockRestore();
  });
});
