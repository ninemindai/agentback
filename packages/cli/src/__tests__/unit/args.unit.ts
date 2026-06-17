// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parseDeployArgs} from '../../args.js';

describe('parseDeployArgs', () => {
  it('parses target + defaults', () => {
    const a = parseDeployArgs(['vercel']);
    expect(a.target).toBe('vercel');
    expect(a.prod).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.console).toBe(false);
    expect(a.verifyPath).toBe('/openapi.json');
  });

  it('parses flags and values', () => {
    const a = parseDeployArgs([
      'vercel',
      '--prod',
      '--name',
      'svc',
      '--entry',
      'dist/main.js',
      '--export',
      'buildApp',
      '--console',
      '--unsafe-public-console',
      '--eject',
      '--force',
      '--dry-run',
      '--yes',
      '--verify-path',
      '/v1/openapi.json',
    ]);
    expect(a).toMatchObject({
      prod: true,
      name: 'svc',
      entry: 'dist/main.js',
      exportName: 'buildApp',
      console: true,
      unsafePublicConsole: true,
      eject: true,
      force: true,
      dryRun: true,
      yes: true,
      verifyPath: '/v1/openapi.json',
    });
  });

  it('throws on missing target', () => {
    expect(() => parseDeployArgs([])).toThrow(/target/i);
  });

  it('throws on unknown target', () => {
    expect(() => parseDeployArgs(['cloudflare'])).toThrow(/vercel/i);
  });

  it('throws on unknown flag', () => {
    expect(() => parseDeployArgs(['vercel', '--bogus'])).toThrow(/unknown/i);
  });
});
