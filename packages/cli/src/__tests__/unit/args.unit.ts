// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {parseDeployArgs, parseNewArgs, parseUpdateArgs} from '../../args.js';

describe('parseUpdateArgs', () => {
  it('defaults to no target, no dry-run, no force', () => {
    expect(parseUpdateArgs([])).toEqual({
      dryRun: false,
      force: false,
      help: false,
    });
  });

  it('parses --to, --dry-run and --force', () => {
    expect(parseUpdateArgs(['--to', '0.10.0', '--dry-run', '--force'])).toEqual(
      {
        to: '0.10.0',
        dryRun: true,
        force: true,
        help: false,
      },
    );
  });

  it('accepts --to=<version> and a prerelease', () => {
    expect(parseUpdateArgs(['--to=0.10.0-rc.1']).to).toBe('0.10.0-rc.1');
  });

  it('rejects a non-exact --to', () => {
    expect(() => parseUpdateArgs(['--to', '^0.10'])).toThrow(/exact version/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseUpdateArgs(['--yolo'])).toThrow(/unknown flag/);
  });
});

describe('parseNewArgs', () => {
  it('defaults to the hybrid template', () => {
    expect(parseNewArgs(['my-svc'])).toMatchObject({
      name: 'my-svc',
      template: 'hybrid',
      capabilities: [],
    });
  });

  it('parses --template and comma-separated --with', () => {
    const a = parseNewArgs([
      'my-svc',
      '--template',
      'rest',
      '--with',
      'drizzle,auth',
    ]);
    expect(a.template).toBe('rest');
    expect(a.capabilities).toEqual(['drizzle', 'auth']);
  });

  it('accepts the --flag=value form like create-agentback does', () => {
    const a = parseNewArgs(['my-svc', '--template=rest', '--with=drizzle']);
    expect(a.template).toBe('rest');
    expect(a.capabilities).toEqual(['drizzle']);
  });

  it('dedupes capabilities across --with and shorthands', () => {
    const a = parseNewArgs(['my-svc', '--with', 'drizzle', '--drizzle']);
    expect(a.capabilities).toEqual(['drizzle']);
  });

  it('parses host options', () => {
    const a = parseNewArgs(['my-svc', '--port', '8080', '--host', '0.0.0.0']);
    expect(a.host).toEqual({port: 8080, host: '0.0.0.0'});
  });

  it('rejects an unknown template', () => {
    expect(() => parseNewArgs(['my-svc', '--template', 'graphql'])).toThrow(
      /unknown template/,
    );
  });

  it('rejects a capability the chosen template does not support', () => {
    // `console` needs an HTTP server; the stdio mcp template has none.
    expect(() =>
      parseNewArgs(['my-svc', '--template', 'mcp', '--with', 'console']),
    ).toThrow(/unknown capability/);
  });

  it('rejects a missing name and points at the interactive entry point', () => {
    expect(() => parseNewArgs([])).toThrow(/npm create agentback/);
  });
});

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

  it('parses --temporary (default false)', () => {
    expect(parseDeployArgs(['cloudflare']).temporary).toBe(false);
    expect(parseDeployArgs(['cloudflare', '--temporary']).temporary).toBe(true);
  });

  it('throws on missing target', () => {
    expect(() => parseDeployArgs([])).toThrow(/target/i);
  });

  it('throws on unknown target', () => {
    expect(() => parseDeployArgs(['fly'])).toThrow(/vercel|cloudflare/i);
  });

  it('accepts cloudflare and its aliases', () => {
    expect(parseDeployArgs(['cloudflare']).target).toBe('cloudflare');
    expect(parseDeployArgs(['cf']).target).toBe('cloudflare');
    expect(parseDeployArgs(['workers']).target).toBe('cloudflare');
  });

  it('still rejects an unknown target', () => {
    expect(() => parseDeployArgs(['fly'])).toThrow(/vercel|cloudflare/i);
  });

  it('throws on unknown flag', () => {
    expect(() => parseDeployArgs(['vercel', '--bogus'])).toThrow(/unknown/i);
  });
});
