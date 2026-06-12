// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadEnvFiles} from '../../dotenv.js';

describe('loadEnvFiles', () => {
  let dir: string;
  const env: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lb-env-'));
    env.NODE_ENV = process.env.NODE_ENV;
    env.A = process.env.A;
    env.B = process.env.B;
    env.C = process.env.C;
    delete process.env.A;
    delete process.env.B;
    delete process.env.C;
  });
  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
    for (const k of ['NODE_ENV', 'A', 'B', 'C']) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });

  it('loads .env and applies values to process.env', () => {
    writeFileSync(join(dir, '.env'), 'A=one\nB=two\n');
    const merged = loadEnvFiles({dir});
    expect(merged).toEqual({A: 'one', B: 'two'});
    expect(process.env.A).toBe('one');
    expect(process.env.B).toBe('two');
  });

  it('layers .env, .env.{NODE_ENV}, .env.local in order', () => {
    process.env.NODE_ENV = 'production';
    writeFileSync(join(dir, '.env'), 'A=base\nB=base\nC=base\n');
    writeFileSync(join(dir, '.env.production'), 'B=prod\n');
    writeFileSync(join(dir, '.env.local'), 'C=local\n');
    // override:true so later overlays win even though process.env was unset
    const merged = loadEnvFiles({dir, override: true});
    expect(merged).toEqual({A: 'base', B: 'prod', C: 'local'});
  });

  it('does not clobber existing process.env values by default', () => {
    process.env.A = 'preset';
    writeFileSync(join(dir, '.env'), 'A=from-file\n');
    loadEnvFiles({dir});
    expect(process.env.A).toBe('preset');
  });

  it('clobbers when override is true', () => {
    process.env.A = 'preset';
    writeFileSync(join(dir, '.env'), 'A=from-file\n');
    loadEnvFiles({dir, override: true});
    expect(process.env.A).toBe('from-file');
  });

  it('is a no-op when no files exist', () => {
    expect(loadEnvFiles({dir})).toEqual({});
  });
});
