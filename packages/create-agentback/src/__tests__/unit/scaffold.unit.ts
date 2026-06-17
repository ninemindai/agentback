// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from 'fs';
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
    // The dot-less `gitignore` template file is restored to `.gitignore`
    // (npm/pnpm strip a literal `.gitignore` from published tarballs).
    expect(result.files).toContain('.gitignore');
    expect(result.files).not.toContain('gitignore');
    expect(readFileSync(path.join(result.dir, '.gitignore'), 'utf8')).toContain(
      'node_modules/',
    );
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

  it('drops the console overlay from a default scaffold', () => {
    const {dir, files} = scaffold({name: 'plain', template: 'hybrid', cwd});
    expect(files).toContain('src/main.ts');
    expect(files).not.toContain('src/main.console.ts');
    const main = readFileSync(path.join(dir, 'src/main.ts'), 'utf8');
    expect(main).toContain('installExplorer');
    expect(main).not.toContain('@agentback/console');
    const pkg = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    expect(pkg.dependencies['@agentback/console']).toBeUndefined();
    expect(pkg.dependencies['@agentback/rest-explorer']).toBeDefined();
  });

  it.each(['hybrid', 'rest'] as const)(
    'wires the console for the %s template with --console',
    template => {
      const {dir, files} = scaffold({
        name: 'svc',
        template,
        console: true,
        cwd,
      });
      // The overlay became main.ts; no leftover overlay file.
      expect(files).toContain('src/main.ts');
      expect(files).not.toContain('src/main.console.ts');
      const main = readFileSync(path.join(dir, 'src/main.ts'), 'utf8');
      expect(main).toContain('installConsole');
      expect(main).toContain('@agentback/console');
      expect(main).not.toContain('installExplorer');
      // Deps swapped: console in, standalone explorers out (no {{version}}).
      const pkg = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
      );
      expect(pkg.dependencies['@agentback/console']).toBeDefined();
      expect(pkg.dependencies['@agentback/console']).not.toContain('{{');
      expect(pkg.dependencies['@agentback/rest-explorer']).toBeUndefined();
      if (template === 'hybrid') {
        expect(pkg.dependencies['@agentback/mcp-inspector']).toBeUndefined();
      }
      // README points at /console, not the explorers.
      const readme = readFileSync(path.join(dir, 'README.md'), 'utf8');
      expect(readme).toContain('/console');
      expect(readme).not.toContain('/explorer');
    },
  );

  it('rejects --console for the stdio mcp template', () => {
    expect(() =>
      scaffold({name: 'x', template: 'mcp', console: true, cwd}),
    ).toThrow(/console.*not supported/i);
    // And does not leave a partial directory behind.
    expect(existsSync(path.join(cwd, 'x'))).toBe(false);
  });
});
