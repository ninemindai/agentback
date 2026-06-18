// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parse} from 'smol-toml';
import {mergeWrangler} from '../../merge-wrangler.js';

const base = {
  name: 'svc',
  main: '.agentback/deploy/cloudflare/worker.ts',
  force: false,
  eject: false,
};

describe('mergeWrangler', () => {
  it('writes a fresh config with nodejs_compat', () => {
    const {toml} = mergeWrangler(undefined, base);
    const o = parse(toml) as any;
    expect(o.name).toBe('svc');
    expect(o.main).toBe(base.main);
    expect(o.compatibility_flags).toContain('nodejs_compat');
    expect(typeof o.compatibility_date).toBe('string');
  });
  it('preserves unrelated user keys', () => {
    const {toml} = mergeWrangler(
      'account_id = "abc"\n[vars]\nFOO = "1"\n',
      base,
    );
    const o = parse(toml) as any;
    expect(o.account_id).toBe('abc');
    expect(o.vars.FOO).toBe('1');
    expect(o.compatibility_flags).toContain('nodejs_compat');
  });
  it('warns + overwrites a conflicting main only under force', () => {
    expect(() => mergeWrangler('main = "src/other.ts"\n', base)).toThrow(
      /main/i,
    );
    const {toml, warnings} = mergeWrangler('main = "src/other.ts"\n', {
      ...base,
      force: true,
    });
    expect((parse(toml) as any).main).toBe(base.main);
    expect(warnings.join(' ')).toMatch(/main/i);
  });
});
