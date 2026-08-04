// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync, mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {runNew} from '../../new.js';

describe('runNew', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-new-'));
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  function deps(): Record<string, string> {
    return (
      JSON.parse(
        readFileSync(path.join(cwd, 'my-svc', 'package.json'), 'utf8'),
      ) as {dependencies: Record<string, string>}
    ).dependencies;
  }

  it('scaffolds a hybrid app into cwd', () => {
    const dir = runNew(
      {name: 'my-svc', template: 'hybrid', capabilities: [], help: false},
      {cwd},
    );
    expect(dir).toBe(path.join(cwd, 'my-svc'));
    expect(existsSync(path.join(dir, 'package.json'))).toBe(true);
    expect(deps()['@agentback/rest']).toBeDefined();
  });

  it('passes capabilities through to scaffold', () => {
    runNew(
      {
        name: 'my-svc',
        template: 'rest',
        capabilities: ['drizzle'],
        help: false,
      },
      {cwd},
    );
    expect(deps()['@agentback/drizzle']).toBeDefined();
  });

  it('bakes host options into the scaffolded app', () => {
    const dir = runNew(
      {
        name: 'my-svc',
        template: 'rest',
        capabilities: [],
        help: false,
        host: {port: 8080},
      },
      {cwd},
    );
    const app = readFileSync(path.join(dir, 'src', 'application.ts'), 'utf8');
    expect(app).toContain('8080');
  });
});
