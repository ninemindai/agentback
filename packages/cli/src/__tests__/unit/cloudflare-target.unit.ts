// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parse} from 'smol-toml';
import {cloudflareTarget} from '../../targets/cloudflare.js';

const opts = {
  builder: {entry: './dist/main.js', exportName: 'buildApp'},
  cwd: '/tmp/app',
  isConsoleBuilder: false,
  force: false,
  eject: false,
};

describe('cloudflareTarget', () => {
  it('generates the worker at the ephemeral path with the correct relative entry', () => {
    const edit = cloudflareTarget.generateEntry(opts);
    expect(edit.path).toBe('.agentback/deploy/cloudflare/worker.ts');
    // worker is 3 dirs deep, so root-relative ./dist/main.js → ../../../dist/main.js
    expect(edit.contents).toContain("from '../../../dist/main.js'");
    expect(edit.contents).toContain('fetchHandler()');
  });
  it('generates a wrangler.toml with nodejs_compat + main', () => {
    const edits = cloudflareTarget.generateConfig({
      ...opts,
      builder: {...opts.builder},
    });
    const wr = edits.find(e => e.path === 'wrangler.toml')!;
    const o = parse(wr.contents) as any;
    expect(o.main).toBe('.agentback/deploy/cloudflare/worker.ts');
    expect(o.compatibility_flags).toContain('nodejs_compat');
  });
  it('verify path is /openapi.json', () => {
    expect(cloudflareTarget.defaultVerifyPath()).toBe('/openapi.json');
  });
});
