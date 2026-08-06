// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  discoverWorkspace,
  readYamlPins,
  rewriteYamlPins,
} from '../../update/workspace.js';

function pkg(root: string, rel: string, body: unknown): void {
  const dir = path.join(root, rel);
  mkdirSync(dir, {recursive: true});
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(body, null, 2) + '\n',
  );
}

describe('discoverWorkspace', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'abc-ws-'));
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  const rels = (r: string, ps: string[]) =>
    ps.map(p => path.relative(r, p)).sort();

  it('expands pnpm-workspace.yaml globs to every sub-package manifest', () => {
    pkg(root, '.', {name: 'root'});
    pkg(root, 'packages/app', {name: 'app'});
    pkg(root, 'packages/base', {name: 'base'});
    pkg(root, 'apps/web', {name: 'web'});
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - \'packages/*\'\n  - "apps/*"\n',
    );
    const ws = discoverWorkspace(root);
    expect(rels(root, ws.manifests)).toEqual([
      'apps/web/package.json',
      'package.json',
      'packages/app/package.json',
      'packages/base/package.json',
    ]);
    expect(ws.manifests[0]).toBe(path.join(root, 'package.json'));
  });

  it('reads a flow-style packages list', () => {
    pkg(root, '.', {name: 'root'});
    pkg(root, 'packages/app', {name: 'app'});
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      "packages: ['packages/*']\n",
    );
    expect(rels(root, discoverWorkspace(root).manifests)).toContain(
      'packages/app/package.json',
    );
  });

  it('expands npm/yarn `workspaces`, array and object forms', () => {
    pkg(root, '.', {name: 'root', workspaces: ['packages/*']});
    pkg(root, 'packages/app', {name: 'app'});
    expect(rels(root, discoverWorkspace(root).manifests)).toEqual([
      'package.json',
      'packages/app/package.json',
    ]);

    pkg(root, '.', {name: 'root', workspaces: {packages: ['packages/*']}});
    expect(rels(root, discoverWorkspace(root).manifests)).toEqual([
      'package.json',
      'packages/app/package.json',
    ]);
  });

  it('honours a `!` negation', () => {
    pkg(root, '.', {name: 'root', workspaces: ['packages/*', '!packages/no']});
    pkg(root, 'packages/yes', {name: 'yes'});
    pkg(root, 'packages/no', {name: 'no'});
    expect(rels(root, discoverWorkspace(root).manifests)).toEqual([
      'package.json',
      'packages/yes/package.json',
    ]);
  });

  it('matches deep packages under `**` without descending node_modules', () => {
    pkg(root, '.', {name: 'root', workspaces: ['packages/**']});
    pkg(root, 'packages/a/b', {name: 'deep'});
    pkg(root, 'packages/a/node_modules/evil', {name: 'evil'});
    expect(rels(root, discoverWorkspace(root).manifests)).toEqual([
      'package.json',
      'packages/a/b/package.json',
    ]);
  });

  it('returns only the root manifest for a non-workspace repo', () => {
    pkg(root, '.', {name: 'solo'});
    pkg(root, 'packages/app', {name: 'app'});
    const ws = discoverWorkspace(root);
    expect(rels(root, ws.manifests)).toEqual(['package.json']);
    expect(ws.pnpmWorkspace).toBeUndefined();
  });
});

// pnpm-workspace.yaml re-pins packages after every range bump, which is what
// made a "successful" field upgrade silently resolve the old version.
const YAML = `packages:
  - 'packages/*'

overrides:
  '@agentback/core': ^0.7.1
  "@agentback/rest": "~0.7.1"   # keep in lockstep
  lodash: ^4.17.21

catalog:
  '@agentback/mcp': 0.7.1
`;

describe('readYamlPins', () => {
  it('reads every @agentback/* pin regardless of its block', () => {
    expect([...readYamlPins(YAML)].sort()).toEqual([
      ['@agentback/core', '^0.7.1'],
      ['@agentback/mcp', '0.7.1'],
      ['@agentback/rest', '~0.7.1'],
    ]);
  });

  it('ignores a packages: glob sequence', () => {
    expect(readYamlPins("packages:\n  - 'packages/*'\n").size).toBe(0);
  });
});

describe('rewriteYamlPins', () => {
  it('rewrites the versions and nothing else', () => {
    const r = rewriteYamlPins(YAML, '0.10.0');
    expect(r.changed.sort()).toEqual([
      '@agentback/core',
      '@agentback/mcp',
      '@agentback/rest',
    ]);
    // Fidelity: quote style, alignment, the trailing comment and every
    // untouched line survive byte-identically. Apps ship no formatter, so a
    // reflowed workspace file is permanent damage.
    expect(r.text).toBe(
      YAML.replace("'@agentback/core': ^0.7.1", "'@agentback/core': ^0.10.0")
        .replace('"@agentback/rest": "~0.7.1"', '"@agentback/rest": "^0.10.0"')
        .replace("'@agentback/mcp': 0.7.1", "'@agentback/mcp': ^0.10.0"),
    );
  });

  it('leaves a file with no @agentback pins byte-identical', () => {
    const src = "packages:\n  - 'packages/*'\n\noverrides:\n  lodash: ^4.0.0\n";
    const r = rewriteYamlPins(src, '0.10.0');
    expect(r.text).toBe(src);
    expect(r.changed).toEqual([]);
  });

  it('reports a pin it cannot rewrite instead of guessing', () => {
    const src = "overrides: {'@agentback/core': ^0.7.1}\n";
    const r = rewriteYamlPins(src, '0.10.0');
    expect(r.text).toBe(src);
    expect(r.changed).toEqual([]);
    expect(r.skipped).toEqual(['@agentback/core']);
  });

  it('reports a range it could not read, and does not rewrite it', () => {
    const src = "overrides:\n  '@agentback/core': latest\n";
    const r = rewriteYamlPins(src, '0.10.0');
    expect(r.text).toBe(src);
    expect(r.skipped).toEqual(['@agentback/core']);
  });
});
