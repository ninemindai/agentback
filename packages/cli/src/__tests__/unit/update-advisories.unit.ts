// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Migration, MigrationContext} from '../../update/migration.js';
import {MIGRATIONS} from '../../update/migrations/index.js';
import {createLazyProject} from '../../update/project.js';

function byId(id: string): Migration {
  const m = MIGRATIONS.find(x => x.id === id);
  if (!m) throw new Error(`no migration ${id}`);
  return m;
}

describe('seed advisories', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'abc-adv-'));
    mkdirSync(path.join(root, 'src'));
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  function ctx(): MigrationContext {
    return {
      root,
      pkg: {},
      project: createLazyProject(root),
      from: '0.8.0',
      to: '0.9.0',
    };
  }

  const src = (body: string) =>
    writeFileSync(path.join(root, 'src', 'app.ts'), body);

  it('registers the advisories at their introducing versions, no apply', () => {
    expect(MIGRATIONS.map(m => m.id).sort()).toEqual([
      'actors-event-json',
      'actors-redis-dedup-ttl',
      'actors-turn-deadline',
      'mcp-origin-validation',
      'mcp-stateless-default',
      'mcp-stateless-scope-holes',
    ]);
    for (const m of MIGRATIONS) {
      expect(m.version).toBe(m.id.startsWith('mcp-') ? '0.9.0' : '0.10.0');
      expect(m.apply).toBeUndefined();
    }
  });

  describe('mcp-stateless-default', () => {
    it('flags eventStore set without an explicit protocol', () => {
      src('installMcpHttp(app, {eventStore: myStore});');
      const f = byId('mcp-stateless-default').detect(ctx());
      expect(f).toHaveLength(1);
      expect(f[0].action).toMatch(/protocol/);
    });

    it('flags code reading Mcp-Session-Id', () => {
      src("const id = req.headers.get('Mcp-Session-Id');");
      expect(byId('mcp-stateless-default').detect(ctx())).toHaveLength(1);
    });

    it('stays silent when protocol is named explicitly', () => {
      src("installMcpHttp(app, {eventStore: myStore, protocol: 'legacy'});");
      expect(byId('mcp-stateless-default').detect(ctx())).toEqual([]);
    });

    it('stays silent on an app that does not mount MCP over HTTP', () => {
      src('export class Foo {}');
      expect(byId('mcp-stateless-default').detect(ctx())).toEqual([]);
    });
  });

  describe('mcp-stateless-scope-holes', () => {
    it('flags scoped tools under optional auth', () => {
      src(
        'installMcpHttp(app, {strategyAuth: {required: false}});\n' +
          "class T { @tool('x', {scope: 'admin'}) run() {} }",
      );
      const f = byId('mcp-stateless-scope-holes').detect(ctx());
      expect(f.some(x => /scope/i.test(x.message))).toBe(true);
    });

    it('flags confirm: tools with no CONFIRMATION_STORE binding', () => {
      src("class T { @tool('confirm:delete') run() {} }");
      const f = byId('mcp-stateless-scope-holes').detect(ctx());
      expect(f.some(x => /CONFIRMATION_STORE/.test(x.action))).toBe(true);
    });

    it('stays silent when a CONFIRMATION_STORE is bound', () => {
      src(
        "class T { @tool('confirm:delete') run() {} }\n" +
          'app.bind(MCPBindings.CONFIRMATION_STORE).to(redisStore);',
      );
      const f = byId('mcp-stateless-scope-holes').detect(ctx());
      expect(f.some(x => /CONFIRMATION_STORE/.test(x.action))).toBe(false);
    });

    it('stays silent on an app with neither pattern', () => {
      src("class T { @tool('plain') run() {} }");
      expect(byId('mcp-stateless-scope-holes').detect(ctx())).toEqual([]);
    });
  });

  describe('actors-turn-deadline', () => {
    it('flags an @actor with no options at all', () => {
      src("@actor('checkout')\nclass Checkout {}");
      const f = byId('actors-turn-deadline').detect(ctx());
      expect(f).toHaveLength(1);
      expect(f[0].message).toMatch(/@actor\('checkout'\)/);
      expect(f[0].action).toMatch(/seatClass: 'worker'/);
    });

    it('flags a defineActor whose options name neither knob', () => {
      src("const a = defineActor('import', {state: S, command: C});");
      expect(byId('actors-turn-deadline').detect(ctx())).toHaveLength(1);
    });

    it('stays silent when seatClass is declared', () => {
      src("@actor('import', {state: S, seatClass: 'worker'})\nclass I {}");
      expect(byId('actors-turn-deadline').detect(ctx())).toEqual([]);
    });

    it('stays silent when deadlineMs is declared', () => {
      src("const a = defineActor('x', {state: S, deadlineMs: 90_000});");
      expect(byId('actors-turn-deadline').detect(ctx())).toEqual([]);
    });

    it('stays silent when the options are not a visible literal', () => {
      src("const a = defineActor('x', sharedOptions);");
      expect(byId('actors-turn-deadline').detect(ctx())).toEqual([]);
    });

    it('stays silent on an app with no actors', () => {
      src('const actor = pickActor(movie); actor.bow();');
      expect(byId('actors-turn-deadline').detect(ctx())).toEqual([]);
    });
  });

  describe('actors-event-json', () => {
    it('flags a bare new Date() inside an events payload', () => {
      src(
        "@actor('t', {state: S, seatClass: 'worker'})\nclass T {}\n" +
          "const turn = {events: [{type: 'Snapshotted', at: new Date()}]};",
      );
      const f = byId('actors-event-json').detect(ctx());
      expect(f).toHaveLength(1);
      expect(f[0].action).toMatch(/toISOString/);
    });

    it('stays silent when the Date is projected to JSON', () => {
      src(
        "@actor('t', {state: S})\nclass T {}\n" +
          "const turn = {events: [{at: new Date().toISOString()}]};",
      );
      expect(byId('actors-event-json').detect(ctx())).toEqual([]);
    });

    it('stays silent on an events property outside an actor app', () => {
      src('analytics.track({events: [{at: new Date()}]});');
      expect(byId('actors-event-json').detect(ctx())).toEqual([]);
    });

    it('stays silent when new Date() is not inside events', () => {
      src("@actor('t', {state: S})\nclass T {}\nconst now = new Date();");
      expect(byId('actors-event-json').detect(ctx())).toEqual([]);
    });
  });

  describe('actors-redis-dedup-ttl', () => {
    it('flags a fractional dedupTtlSeconds', () => {
      src('new RedisActorRuntime(r, {dedupTtlSeconds: 0.5});');
      expect(byId('actors-redis-dedup-ttl').detect(ctx())).toHaveLength(1);
    });

    it('flags a negative dedupTtlSeconds', () => {
      src('new RedisActorRuntime(r, {dedupTtlSeconds: -1});');
      expect(byId('actors-redis-dedup-ttl').detect(ctx())).toHaveLength(1);
    });

    it('stays silent on whole seconds', () => {
      src('new RedisActorRuntime(r, {dedupTtlSeconds: 3600});');
      expect(byId('actors-redis-dedup-ttl').detect(ctx())).toEqual([]);
    });
  });

  describe('mcp-origin-validation', () => {
    it('flags a wildcard cors with no allowedOrigins', () => {
      src('installMcpHttp(app, {});\nconst c = {rest: {cors: true}};');
      expect(byId('mcp-origin-validation').detect(ctx())).toHaveLength(1);
    });

    it('stays silent when allowedOrigins is set', () => {
      src(
        "installMcpHttp(app, {allowedOrigins: ['x.dev']});\n" +
          'const c = {rest: {cors: true}};',
      );
      expect(byId('mcp-origin-validation').detect(ctx())).toEqual([]);
    });

    it('stays silent without a wildcard cors', () => {
      src('installMcpHttp(app, {});');
      expect(byId('mcp-origin-validation').detect(ctx())).toEqual([]);
    });
  });
});
