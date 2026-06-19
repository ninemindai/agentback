// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parse} from 'smol-toml';
import type {Exec, ExecResult} from '../../exec.js';
import {parseDeployArgs} from '../../args.js';
import {cloudflareTarget} from '../../targets/cloudflare.js';

const opts = {
  builder: {entry: './dist/main.js', exportName: 'buildApp'},
  cwd: '/tmp/app',
  isConsoleBuilder: false,
  force: false,
  eject: false,
};

// Records the wrangler invocations and replays canned results keyed by the
// joined args (e.g. 'deploy --temporary').
function fakeExec(responses: Record<string, ExecResult>) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return responses[args.join(' ')] ?? {code: 0, stdout: '', stderr: ''};
  };
  return {exec, calls};
}

const deps = (exec: Exec) => ({exec, fetchFn: fetch, cwd: '/tmp/app'});

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

  it('deploy gates on `wrangler whoami`, then runs `wrangler deploy` and parses the url', async () => {
    const {exec, calls} = fakeExec({
      whoami: {code: 0, stdout: 'logged in', stderr: ''},
      deploy: {code: 0, stdout: '  https://app.acct.workers.dev\n', stderr: ''},
    });
    const args = parseDeployArgs(['cloudflare']);
    const res = await cloudflareTarget.deploy(args, deps(exec));
    expect(res.url).toBe('https://app.acct.workers.dev');
    expect(calls).toEqual([
      ['wrangler', 'whoami'],
      ['wrangler', 'deploy'],
    ]);
  });

  it('--temporary skips the whoami gate and forwards --temporary to deploy', async () => {
    const {exec, calls} = fakeExec({
      'deploy --temporary': {
        code: 0,
        stdout: 'Deployed\n  https://app.shared-axolotl.workers.dev\n',
        stderr: '',
      },
    });
    const args = {...parseDeployArgs(['cloudflare']), temporary: true};
    const res = await cloudflareTarget.deploy(args, deps(exec));
    expect(res.url).toBe('https://app.shared-axolotl.workers.dev');
    expect(calls.some(c => c.includes('whoami'))).toBe(false);
    expect(calls).toContainEqual(['wrangler', 'deploy', '--temporary']);
  });
});
