// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {Application} from '@agentback/core';
import {ConfigComponent} from '../../config.component.js';
import {ConfigBindings} from '../../keys.js';
import {Configuration} from '../../configuration.js';

describe('ConfigComponent', () => {
  let dir: string;
  let saved: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lb-cfg-comp-'));
    saved = process.env.CONFIG_DIR;
    process.env.CONFIG_DIR = dir;
  });
  afterEach(() => {
    rmSync(dir, {recursive: true, force: true});
    if (saved === undefined) delete process.env.CONFIG_DIR;
    else process.env.CONFIG_DIR = saved;
  });

  it('binds the resolved config dir and a Configuration service', async () => {
    const app = new Application();
    app.component(ConfigComponent);

    expect(await app.get(ConfigBindings.CONFIG_DIR)).toBe(dir);
    const cfg = await app.get(ConfigBindings.CONFIGURATION);
    expect(cfg).toBeInstanceOf(Configuration);
    expect(cfg.dir).toBe(dir);
  });

  it('Configuration.bind() puts the validated value in the context', async () => {
    writeFileSync(join(dir, 'redis.jsonc'), '{ "url": "redis://x" }');

    const app = new Application();
    app.component(ConfigComponent);
    const cfg = await app.get(ConfigBindings.CONFIGURATION);
    cfg.bind('redis.jsonc', z.object({url: z.string()}));

    expect(await app.get('config.redis')).toEqual({url: 'redis://x'});
  });
});
