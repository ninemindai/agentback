// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {runVercelDeploy} from '../../run-vercel.js';
import {parseDeployArgs} from '../../args.js';
import type {Exec} from '../../exec.js';

const okFetch = (async () => new Response('{}', {status: 200})) as unknown as typeof fetch;

function fakeExec(map: Record<string, {code: number; stdout?: string}>): Exec {
  return async (cmd, args) => {
    const key = `${cmd} ${args[0] ?? ''}`.trim();
    const r = map[key] ?? {code: 0};
    return {code: r.code, stdout: r.stdout ?? '', stderr: ''};
  };
}

describe('runVercelDeploy', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-run-'));
    mkdirSync(path.join(cwd, 'dist'));
    writeFileSync(path.join(cwd, 'dist', 'main.js'), '');
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  it('writes root files and stops on --eject', async () => {
    const exec = vi.fn(fakeExec({}));
    const out = await runVercelDeploy(parseDeployArgs(['vercel', '--eject']), {exec, fetchFn: okFetch, cwd});
    expect(out.status).toBe('ejected');
    expect(existsSync(path.join(cwd, 'api', 'index.ts'))).toBe(true);
    expect(existsSync(path.join(cwd, 'vercel.json'))).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('--dry-run preflights but never deploys', async () => {
    const exec = vi.fn(fakeExec({'vercel whoami': {code: 0}}));
    const out = await runVercelDeploy(parseDeployArgs(['vercel', '--dry-run']), {exec, fetchFn: okFetch, cwd});
    expect(out.status).toBe('dry-run');
    // whoami may run; deploy must not.
    const calledDeploy = exec.mock.calls.some(c => c[1][0] === 'deploy');
    expect(calledDeploy).toBe(false);
  });

  it('deploys, parses url, verifies', async () => {
    const exec = fakeExec({
      'vercel whoami': {code: 0},
      'vercel deploy': {code: 0, stdout: 'https://demo-abc.vercel.app\n'},
    });
    const out = await runVercelDeploy(parseDeployArgs(['vercel']), {exec, fetchFn: okFetch, cwd});
    expect(out.status).toBe('deployed');
    expect(out.url).toBe('https://demo-abc.vercel.app');
    expect(out.verify?.ok).toBe(true);
  });

  it('throws an actionable error when not authed', async () => {
    const exec = fakeExec({'vercel whoami': {code: 1}});
    await expect(
      runVercelDeploy(parseDeployArgs(['vercel']), {exec, fetchFn: okFetch, cwd}),
    ).rejects.toThrow(/login/i);
  });

  it('refuses to clobber an existing api/index.ts without --force', async () => {
    mkdirSync(path.join(cwd, 'api'));
    writeFileSync(path.join(cwd, 'api', 'index.ts'), '// user file');
    await expect(
      runVercelDeploy(parseDeployArgs(['vercel', '--eject']), {exec: fakeExec({}), fetchFn: okFetch, cwd}),
    ).rejects.toThrow(/force/i);
  });
});
