// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  detectAppPackageManager,
  installCommand,
} from '../../update/package-manager.js';

describe('detectAppPackageManager', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'abc-pm-'));
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  const lock = (f: string) => writeFileSync(path.join(root, f), '');
  const pkg = (o: unknown) =>
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(o));

  it('detects each manager from its lockfile', () => {
    for (const [file, expected] of [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['package-lock.json', 'npm'],
    ] as const) {
      // A fresh directory per case — one lockfile at a time, or the
      // precedence order would decide the answer instead of the detection.
      const dir = mkdtempSync(path.join(tmpdir(), 'abc-pm-one-'));
      writeFileSync(path.join(dir, file), '');
      expect(detectAppPackageManager(dir)).toBe(expected);
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it('falls back to npm when no lockfile exists', () => {
    expect(detectAppPackageManager(root)).toBe('npm');
  });

  it('prefers pnpm when several lockfiles are present', () => {
    lock('package-lock.json');
    lock('pnpm-lock.yaml');
    expect(detectAppPackageManager(root)).toBe('pnpm');
  });

  it('lets the Corepack packageManager field beat the lockfile', () => {
    lock('package-lock.json');
    pkg({packageManager: 'pnpm@11.2.0'});
    expect(detectAppPackageManager(root)).toBe('pnpm');
  });

  it('falls back to the lockfile when packageManager names an unknown tool', () => {
    lock('yarn.lock');
    pkg({packageManager: 'nx@1.0.0'});
    expect(detectAppPackageManager(root)).toBe('yarn');
  });

  it('survives a malformed package.json', () => {
    writeFileSync(path.join(root, 'package.json'), '{not json');
    lock('pnpm-lock.yaml');
    expect(detectAppPackageManager(root)).toBe('pnpm');
  });
});

describe('installCommand', () => {
  it('maps each manager to its install invocation', () => {
    // `.cmd` on Windows: spawn() without a shell cannot execute the shim.
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    for (const pm of ['pnpm', 'yarn', 'bun', 'npm'] as const) {
      expect(installCommand(pm)).toEqual({
        cmd: `${pm}${suffix}`,
        args: ['install'],
      });
    }
  });
});
