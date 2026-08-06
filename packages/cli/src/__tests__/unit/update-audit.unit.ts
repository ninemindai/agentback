// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {auditVersions} from '../../update/audit.js';

function json(root: string, rel: string, body: unknown): void {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
}

describe('auditVersions', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'abc-audit-'));
    json(root, 'package.json', {
      name: 'root',
      dependencies: {'@agentback/core': '^0.10.0'},
    });
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  it('passes a tree where every pin and every install is at the target', () => {
    json(root, 'packages/app/package.json', {
      name: 'app',
      dependencies: {'@agentback/rest': '^0.10.0'},
    });
    json(root, 'node_modules/@agentback/core/package.json', {
      name: '@agentback/core',
      version: '0.10.1',
    });
    expect(auditVersions(root, '0.10.0')).toEqual([]);
  });

  // The net must re-derive its own view of the tree, or it can only catch the
  // failures the bump enumerator already knows how to look for. This manifest
  // is invisible to both workspace globs (there are none) and to the root
  // manifest — a plain filesystem walk is what finds it.
  it('flags a stale pin in a manifest no workspace glob covers', () => {
    json(root, 'services/api/package.json', {
      name: 'api',
      dependencies: {'@agentback/mcp': '^0.7.1'},
    });
    const stale = auditVersions(root, '0.10.0');
    expect(stale).toHaveLength(1);
    expect(stale[0].site).toBe(path.join('services', 'api', 'package.json'));
    expect(stale[0].name).toBe('@agentback/mcp');
    expect(stale[0].found).toBe('^0.7.1');
  });

  it('flags a stale pin in devDependencies and in npm overrides', () => {
    json(root, 'packages/app/package.json', {
      name: 'app',
      devDependencies: {'@agentback/testing': '^0.9.0'},
      overrides: {'@agentback/rest': '0.9.0'},
    });
    expect(
      auditVersions(root, '0.10.0')
        .map(s => s.name)
        .sort(),
    ).toEqual(['@agentback/rest', '@agentback/testing']);
  });

  it('flags a stale pnpm-workspace.yaml override', () => {
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      "overrides:\n  '@agentback/core': ^0.7.1\n",
    );
    const stale = auditVersions(root, '0.10.0');
    expect(stale).toHaveLength(1);
    expect(stale[0].site).toBe('pnpm-workspace.yaml');
  });

  it('flags an installed package below the target', () => {
    json(root, 'node_modules/@agentback/core/package.json', {
      name: '@agentback/core',
      version: '0.7.1',
    });
    const stale = auditVersions(root, '0.10.0');
    expect(stale).toHaveLength(1);
    expect(stale[0].found).toBe('0.7.1');
    expect(stale[0].site).toContain('node_modules');
  });

  it('flags a stale install nested in a workspace package', () => {
    json(root, 'packages/app/package.json', {
      name: 'app',
      dependencies: {'@agentback/rest': '^0.10.0'},
    });
    json(root, 'packages/app/node_modules/@agentback/rest/package.json', {
      name: '@agentback/rest',
      version: '0.7.1',
    });
    expect(auditVersions(root, '0.10.0')).toHaveLength(1);
  });

  it('does not flag a range it cannot read, or a workspace: protocol', () => {
    json(root, 'packages/app/package.json', {
      name: 'app',
      dependencies: {
        '@agentback/rest': 'latest',
        '@agentback/mcp': 'workspace:~',
      },
    });
    expect(auditVersions(root, '0.10.0')).toEqual([]);
  });

  it('does not flag a pin ahead of the target', () => {
    json(root, 'packages/app/package.json', {
      name: 'app',
      dependencies: {'@agentback/rest': '^0.11.0'},
    });
    expect(auditVersions(root, '0.10.0')).toEqual([]);
  });

  it('ignores a malformed manifest rather than throwing mid-audit', () => {
    mkdirSync(path.join(root, 'packages/broken'), {recursive: true});
    writeFileSync(path.join(root, 'packages/broken/package.json'), '{oops');
    expect(auditVersions(root, '0.10.0')).toEqual([]);
  });
});
