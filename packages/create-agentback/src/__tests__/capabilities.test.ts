// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {scaffold} from '../scaffold.js';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'cab-'));
});
afterEach(() => {
  rmSync(cwd, {recursive: true, force: true});
});

function appFile(dir: string, rel: string): string {
  return readFileSync(path.join(dir, rel), 'utf8');
}

describe('host options + anchor stripping', () => {
  it('strips all anchors from a plain rest scaffold', () => {
    const {dir} = scaffold({name: 'plain', template: 'rest', cwd});
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).not.toContain('{{agentback:');
    expect(appTs).toContain('super({})');
  });

  it('renders host options into the rest config', () => {
    const {dir} = scaffold({
      name: 'hosted',
      template: 'rest',
      cwd,
      host: {port: 8080, host: '0.0.0.0', basePath: '/api'},
    });
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).toContain("rest: {port: 8080, host: '0.0.0.0', basePath: '/api'}");
    expect(appTs).not.toContain('{{agentback:');
  });

  it('rejects host options for the stdio mcp template', () => {
    expect(() =>
      scaffold({name: 'bad', template: 'mcp', cwd, host: {port: 9000}}),
    ).toThrow(/host options.*mcp/i);
  });
});
