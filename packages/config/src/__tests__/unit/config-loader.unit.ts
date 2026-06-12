// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {
  ConfigValidationError,
  getConfigDir,
  loadConfigFile,
  loadRawConfigFile,
  shallowMergeConfigs,
} from '../../config-loader.js';

function writeFixtures(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
}

describe('shallowMergeConfigs', () => {
  it('shallow-merges section entries', () => {
    const merged = shallowMergeConfigs(
      {servers: {a: {disabled: true, cmd: 'x'}}},
      {servers: {a: {disabled: false}, b: {cmd: 'y'}}},
    );
    expect(merged).toEqual({
      servers: {a: {disabled: false, cmd: 'x'}, b: {cmd: 'y'}},
    });
  });

  it('replaces primitives and arrays at the root', () => {
    expect(shallowMergeConfigs({k: 1, arr: [1]}, {k: 2, arr: [9]})).toEqual({
      k: 2,
      arr: [9],
    });
  });
});

describe('config loader (filesystem)', () => {
  let dir: string;
  const env: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lb-cfg-'));
    env.CONFIG_DIR = process.env.CONFIG_DIR;
    env.PROJECT_ROOT = process.env.PROJECT_ROOT;
    env.NODE_ENV = process.env.NODE_ENV;
    env.SECRET = process.env.SECRET;
    process.env.CONFIG_DIR = dir;
    delete process.env.PROJECT_ROOT;
  });

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
    for (const k of ['CONFIG_DIR', 'PROJECT_ROOT', 'NODE_ENV', 'SECRET']) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });

  it('honors CONFIG_DIR', () => {
    expect(getConfigDir()).toBe(dir);
  });

  it('loads JSONC and validates with Zod', () => {
    writeFixtures(dir, {'app.jsonc': '{ "port": 3000, /* api */ }'});
    const schema = z.object({port: z.number()});
    expect(loadConfigFile('app.jsonc', schema)).toEqual({port: 3000});
  });

  it('loads YAML', () => {
    writeFixtures(dir, {'db.yaml': 'host: localhost\nport: 5432\n'});
    const schema = z.object({host: z.string(), port: z.number()});
    expect(loadConfigFile('db.yaml', schema)).toEqual({
      host: 'localhost',
      port: 5432,
    });
  });

  it('finds the file when the extension is omitted', () => {
    writeFixtures(dir, {'app.json': '{"a": 1}'});
    expect(loadRawConfigFile('app')).toEqual({a: 1});
  });

  it('throws ConfigValidationError with the bad path', () => {
    writeFixtures(dir, {'app.json': '{"port": "nope"}'});
    expect(() =>
      loadConfigFile('app.json', z.object({port: z.number()})),
    ).toThrow(ConfigValidationError);
  });

  it('resolves ${ENV} references on load', () => {
    process.env.SECRET = 'shh';
    writeFixtures(dir, {'app.json': '{"token": "${SECRET}"}'});
    expect(loadRawConfigFile('app.json')).toEqual({token: 'shh'});
  });

  it('layers env and local overlays', () => {
    process.env.NODE_ENV = 'production';
    writeFixtures(dir, {
      'app.json': '{"server": {"port": 1, "host": "base"}}',
      'app.production.json': '{"server": {"port": 2}}',
      'app.local.json': '{"server": {"host": "local"}}',
    });
    expect(loadRawConfigFile('app.json')).toEqual({
      server: {port: 2, host: 'local'},
    });
  });

  it('returns undefined when the base file is missing', () => {
    expect(loadRawConfigFile('nope.json')).toBeUndefined();
  });
});
