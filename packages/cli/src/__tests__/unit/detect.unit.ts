// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resolveBuilder, enforceConsoleGate} from '../../detect.js';

describe('resolveBuilder', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-cli-'));
    mkdirSync(path.join(cwd, 'dist'));
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  it('honors explicit --entry/--export', () => {
    const r = resolveBuilder({entry: './dist/x.js', exportName: 'mk', cwd});
    expect(r).toEqual({entry: './dist/x.js', exportName: 'mk'});
  });

  it('defaults export to buildApp when only --entry given', () => {
    expect(resolveBuilder({entry: './dist/x.js', cwd}).exportName).toBe(
      'buildApp',
    );
  });

  it('detects dist/console.js → buildConsoleApp', () => {
    writeFileSync(path.join(cwd, 'dist', 'console.js'), '');
    expect(resolveBuilder({cwd})).toEqual({
      entry: './dist/console.js',
      exportName: 'buildConsoleApp',
    });
  });

  it('detects dist/main.js → buildApp', () => {
    writeFileSync(path.join(cwd, 'dist', 'main.js'), '');
    expect(resolveBuilder({cwd})).toEqual({
      entry: './dist/main.js',
      exportName: 'buildApp',
    });
  });

  it('throws an actionable error when nothing resolves', () => {
    expect(() => resolveBuilder({cwd})).toThrow(/--entry/);
  });
});

describe('enforceConsoleGate', () => {
  it('no-op when console is off', () => {
    expect(() =>
      enforceConsoleGate({console: false, unsafePublicConsole: false}),
    ).not.toThrow();
  });
  it('throws when --console without acknowledgement', () => {
    expect(() =>
      enforceConsoleGate({console: true, unsafePublicConsole: false}),
    ).toThrow(/unsafe-public-console/);
  });
  it('allows --console with --unsafe-public-console', () => {
    expect(() =>
      enforceConsoleGate({console: true, unsafePublicConsole: true}),
    ).not.toThrow();
  });
});
