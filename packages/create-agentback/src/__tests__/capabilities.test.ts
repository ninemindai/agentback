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
    expect(appTs).toContain(
      "rest: {port: 8080, host: '0.0.0.0', basePath: '/api'}",
    );
    expect(appTs).not.toContain('{{agentback:');
  });

  it('rejects host options for the stdio mcp template', () => {
    expect(() =>
      scaffold({name: 'bad', template: 'mcp', cwd, host: {port: 9000}}),
    ).toThrow(/host options.*mcp/i);
  });
});

import {CAPABILITIES, capabilityNames} from '../capabilities.js';

describe('capability registry', () => {
  it('lists console as a registered capability for rest+hybrid only', () => {
    const cap = CAPABILITIES.find(c => c.name === 'console');
    expect(cap).toBeDefined();
    expect(cap!.templates).toEqual(['hybrid', 'rest']);
  });

  it('exposes capability names valid for a given template', () => {
    expect(capabilityNames('mcp')).not.toContain('console');
    expect(capabilityNames('rest')).toContain('console');
  });

  it('--console via capabilities retargets deps to @agentback/console', () => {
    const {dir} = scaffold({
      name: 'consoled',
      template: 'hybrid',
      cwd,
      capabilities: ['console'],
    });
    const pkg = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    expect(pkg.dependencies['@agentback/console']).toBeDefined();
    expect(pkg.dependencies['@agentback/rest-explorer']).toBeUndefined();
  });

  it('rejects a capability incompatible with the template', () => {
    expect(() =>
      scaffold({name: 'x', template: 'mcp', cwd, capabilities: ['console']}),
    ).toThrow(/console.*not supported/i);
  });
});

describe('drizzle capability', () => {
  it('adds drizzle deps + schema + controller for hybrid', () => {
    const {dir} = scaffold({
      name: 'dz',
      template: 'hybrid',
      cwd,
      capabilities: ['drizzle'],
    });
    const pkg = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    expect(pkg.dependencies['@agentback/drizzle']).toBeDefined();
    expect(pkg.dependencies['drizzle-orm']).toBe('^0.45.2');
    expect(appFile(dir, 'src/db/schema.ts')).toContain('pgTable');
    expect(appFile(dir, 'src/controllers/users.controller.ts')).toContain(
      '@mcpServer',
    );
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).toContain('this.restController(UsersController)');
    expect(appTs).toContain('this.service(UsersController)');
    expect(appTs).toContain('USER_STORE');
    expect(appTs).not.toContain('{{agentback:');
  });

  it('uses a tool-only controller for the mcp template', () => {
    const {dir} = scaffold({
      name: 'dzm',
      template: 'mcp',
      cwd,
      capabilities: ['drizzle'],
    });
    expect(appFile(dir, 'src/tools/users.tools.ts')).toContain('@tool');
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).toContain('this.service(UsersTools)');
    expect(appTs).not.toContain('restController');
  });
});

describe('auth capability', () => {
  it('adds jwt deps + auth controller + component wiring for rest', () => {
    const {dir} = scaffold({
      name: 'au',
      template: 'rest',
      cwd,
      capabilities: ['auth'],
    });
    const pkg = JSON.parse(
      readFileSync(path.join(dir, 'package.json'), 'utf8'),
    );
    expect(pkg.dependencies['@agentback/authentication-jwt']).toBeDefined();
    expect(pkg.dependencies['jsonwebtoken']).toBe('^9.0.2');
    expect(appFile(dir, 'src/controllers/auth.controller.ts')).toContain(
      '@authenticate',
    );
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).toContain('JWTAuthenticationComponent');
    expect(appTs).toContain('this.restController(AuthController)');
    expect(appTs).not.toContain('{{agentback:');
  });

  it('rejects auth for the mcp template', () => {
    expect(() =>
      scaffold({name: 'x', template: 'mcp', cwd, capabilities: ['auth']}),
    ).toThrow(/auth.*not supported/i);
  });
});
