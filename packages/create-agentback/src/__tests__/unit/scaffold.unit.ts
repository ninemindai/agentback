// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {scaffold, TEMPLATES} from '../../scaffold.js';

describe('scaffold', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'cla-test-'));
  });

  afterEach(() => {
    rmSync(cwd, {recursive: true, force: true});
  });

  it.each(TEMPLATES)('scaffolds the %s template', template => {
    const result = scaffold({name: 'my-service', template, cwd});
    expect(result.dir).toBe(path.join(cwd, 'my-service'));
    const pkg = JSON.parse(
      readFileSync(path.join(result.dir, 'package.json'), 'utf8'),
    );
    expect(pkg.name).toBe('my-service');
    // Every @AgentBack dep got the version substituted.
    for (const [dep, range] of Object.entries({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }) as [string, string][]) {
      expect(range, `${dep} version untouched`).not.toContain('{{version}}');
    }
    // Structural sanity: app + test + tsconfig exist.
    expect(result.files).toContain('tsconfig.json');
    expect(result.files.some(f => f.startsWith('src/'))).toBe(true);
    expect(result.files.some(f => f.includes('__tests__'))).toBe(true);
    // README mentions the app by name.
    const readme = readFileSync(path.join(result.dir, 'README.md'), 'utf8');
    expect(readme).toContain('my-service');
    expect(readme).not.toContain('{{name}}');
  });

  it('substitutes the name into source files', () => {
    const {dir} = scaffold({name: 'acme-api', template: 'hybrid', cwd});
    const main = readFileSync(path.join(dir, 'src/main.ts'), 'utf8');
    expect(main).toContain('acme-api');
    expect(main).not.toContain('{{name}}');
  });

  it('uses the directory part of a scoped name', () => {
    const {dir} = scaffold({name: '@acme/api', template: 'rest', cwd});
    expect(path.basename(dir)).toBe('api');
    const pkg = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    expect(pkg.name).toBe('@acme/api');
  });

  it('honors an explicit version range', () => {
    const {dir} = scaffold({
      name: 'pinned',
      template: 'rest',
      cwd,
      version: '~9.9.9',
    });
    const pkg = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    expect(pkg.dependencies['@agentback/rest']).toBe('~9.9.9');
  });

  it('rejects invalid names', () => {
    expect(() => scaffold({name: 'Bad Name!', cwd})).toThrow(
      /Invalid app name/,
    );
  });

  it('rejects unknown templates', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      scaffold({name: 'x', template: 'nope' as any, cwd}),
    ).toThrow(/Unknown template/);
  });

  it('refuses a non-empty target directory', () => {
    mkdirSync(path.join(cwd, 'taken'));
    writeFileSync(path.join(cwd, 'taken', 'f.txt'), 'x');
    expect(() => scaffold({name: 'taken', cwd})).toThrow(/not empty/);
  });
});
