// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Exec, ExecResult} from '../../exec.js';
import type {Migration} from '../../update/migration.js';
import {
  printUpdateReport,
  runUpdate,
  type UpdateReport,
} from '../../update/run-update.js';

function stubExec(clean = true): {exec: Exec; calls: string[][]} {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const res: ExecResult = {code: 0, stdout: '', stderr: ''};
    if (cmd === 'git') return {...res, stdout: clean ? '' : ' M src/app.ts\n'};
    return res;
  };
  return {exec, calls};
}

const PKG = {
  name: 'my-svc',
  dependencies: {'@agentback/core': '^0.9.0', zod: '^4.4.3'},
  devDependencies: {'@agentback/testing': '^0.9.0'},
};

const PM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function seed(cwd: string, pkg: unknown = PKG, indent = 2): void {
  mkdirSync(path.join(cwd, 'src'), {recursive: true});
  writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export class A {}\n');
  writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify(pkg, null, indent) + '\n',
  );
  writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '');
}

describe('runUpdate', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-upd-'));
    seed(cwd);
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  it('bumps every @agentback/* range and installs with the app manager', async () => {
    const {exec, calls} = stubExec();
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );

    expect(r.from).toBe('0.9.0');
    expect(r.to).toBe('0.10.0');
    expect(r.changed.sort()).toEqual(['@agentback/core', '@agentback/testing']);

    const pkg = JSON.parse(
      readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    ) as typeof PKG;
    expect(pkg.dependencies['@agentback/core']).toBe('^0.10.0');
    expect(pkg.dependencies.zod).toBe('^4.4.3');
    expect(calls).toContainEqual([PM, 'install']);
    expect(r.installed).toBe(true);
  });

  it('writes nothing and installs nothing under --dry-run', async () => {
    const {exec, calls} = stubExec();
    const before = readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const r = await runUpdate(
      {dryRun: true, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );

    expect(readFileSync(path.join(cwd, 'package.json'), 'utf8')).toBe(before);
    expect(calls).not.toContainEqual([PM, 'install']);
    expect(r.installed).toBe(false);
    expect(r.changed.sort()).toEqual(['@agentback/core', '@agentback/testing']);
  });

  it('refuses a dirty git tree without --force', async () => {
    const {exec} = stubExec(false);
    await expect(
      runUpdate(
        {dryRun: false, force: false, help: false, to: '0.10.0'},
        {exec, cwd, selfVersion: '0.10.0'},
      ),
    ).rejects.toThrow(/uncommitted changes/);
  });

  it('allows a dirty tree under --force', async () => {
    const {exec} = stubExec(false);
    const r = await runUpdate(
      {dryRun: false, force: true, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.installed).toBe(true);
  });

  it('refuses when the CLI is older than the target', async () => {
    const {exec} = stubExec();
    await expect(
      runUpdate(
        {dryRun: false, force: false, help: false, to: '0.11.0'},
        {exec, cwd, selfVersion: '0.10.0'},
      ),
    ).rejects.toThrow(/npx @agentback\/cli@latest/);
  });

  it('defaults the target to the running CLI version', async () => {
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: true, force: false, help: false},
      {exec, cwd, selfVersion: '0.12.0'},
    );
    expect(r.to).toBe('0.12.0');
  });

  it('refuses a downgrade without --force', async () => {
    const {exec} = stubExec();
    await expect(
      runUpdate(
        {dryRun: false, force: false, help: false, to: '0.8.0'},
        {exec, cwd, selfVersion: '0.12.0'},
      ),
    ).rejects.toThrow(/older than the app's current/);
  });

  it('preserves the manifest indentation', async () => {
    rmSync(cwd, {recursive: true, force: true});
    mkdirSync(cwd, {recursive: true});
    seed(cwd, PKG, 4);
    const {exec} = stubExec();
    await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    const after = readFileSync(path.join(cwd, 'package.json'), 'utf8');
    expect(after).toContain('\n    "name"');
    expect(after).not.toContain('\n  "name"');
  });

  it('warns instead of silently proceeding when the git guard cannot run', async () => {
    const exec: Exec = async cmd =>
      cmd === 'git'
        ? {code: 127, stdout: '', stderr: 'command not found'}
        : {code: 0, stdout: '', stderr: ''};
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.warnings.join(' ')).toMatch(
      /Could not verify the git working tree/,
    );
  });
});

// The seam that joins resolve -> select -> detect -> report. Without this, the
// advisories are tested in isolation and runUpdate is tested with an empty
// migration window, so nothing proves the two halves connect.
describe('runUpdate phase 2 (migrations)', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-mig-'));
    seed(cwd, {...PKG, dependencies: {'@agentback/core': '^0.8.0'}});
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  const advisory: Migration = {
    id: 'fake-advisory',
    version: '0.9.0',
    title: 'fake',
    detect: () => [{message: 'found it', action: 'do the thing'}],
  };

  it('surfaces findings from a migration inside the window', async () => {
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0', migrations: [advisory]},
    );
    expect(r.findings).toEqual([
      {message: 'found it', action: 'do the thing', migration: 'fake-advisory'},
    ]);
  });

  it('runs apply() outside dry-run and skips it inside', async () => {
    const applied: string[] = [];
    const codemod: Migration = {
      ...advisory,
      id: 'fake-codemod',
      apply: () => applied.push('ran'),
    };
    const {exec} = stubExec();
    const opts = {force: false, help: false, to: '0.10.0'};

    await runUpdate(
      {...opts, dryRun: true},
      {exec, cwd, selfVersion: '0.10.0', migrations: [codemod]},
    );
    expect(applied).toEqual([]);

    await runUpdate(
      {...opts, dryRun: false},
      {exec, cwd, selfVersion: '0.10.0', migrations: [codemod]},
    );
    expect(applied).toEqual(['ran']);
  });

  it('leaves package.json un-bumped when a migration throws', async () => {
    const exploding: Migration = {
      ...advisory,
      id: 'boom',
      apply: () => {
        throw new Error('transform failed');
      },
    };
    const {exec} = stubExec();
    await expect(
      runUpdate(
        {dryRun: false, force: false, help: false, to: '0.10.0'},
        {exec, cwd, selfVersion: '0.10.0', migrations: [exploding]},
      ),
    ).rejects.toThrow(/transform failed/);

    // The whole point of migrating before bumping: a failed run must not move
    // `from` forward, or the re-run silently skips the migration window.
    const pkg = JSON.parse(
      readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    ) as {dependencies: Record<string, string>};
    expect(pkg.dependencies['@agentback/core']).toBe('^0.8.0');
  });
});

// Field report from two real upgrades: both apps kept their code and their
// @agentback pins in workspace sub-packages, so a root-only update looked like
// it worked and left the old version resolving.
describe('runUpdate across a workspace', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'abc-ws-upd-'));
    seed(cwd);
  });
  afterEach(() => rmSync(cwd, {recursive: true, force: true}));

  function sub(rel: string, pkg: unknown, src?: string): void {
    mkdirSync(path.join(cwd, rel, 'src'), {recursive: true});
    writeFileSync(
      path.join(cwd, rel, 'package.json'),
      JSON.stringify(pkg, null, 2) + '\n',
    );
    if (src) writeFileSync(path.join(cwd, rel, 'src', 'app.ts'), src);
  }

  const readPkg = (rel: string) =>
    JSON.parse(readFileSync(path.join(cwd, rel, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };

  it('bumps sub-package pins reached through a pnpm workspace', async () => {
    writeFileSync(
      path.join(cwd, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
    );
    sub('packages/app', {
      name: 'app',
      dependencies: {'@agentback/rest': '^0.9.0', zod: '^4.4.3'},
    });
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );

    expect(readPkg('packages/app').dependencies['@agentback/rest']).toBe(
      '^0.10.0',
    );
    expect(readPkg('packages/app').dependencies.zod).toBe('^4.4.3');
    expect(r.changed).toContain(
      `packages/app/package.json:@agentback/rest`.replaceAll('/', path.sep),
    );
    expect(r.stale).toEqual([]);
  });

  it('bumps sub-package pins reached through npm `workspaces`', async () => {
    seed(cwd, {...PKG, workspaces: ['packages/*']});
    sub('packages/app', {
      name: 'app',
      dependencies: {'@agentback/rest': '^0.9.0'},
    });
    const {exec} = stubExec();
    await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(readPkg('packages/app').dependencies['@agentback/rest']).toBe(
      '^0.10.0',
    );
  });

  it('rewrites pnpm-workspace.yaml overrides without reflowing the file', async () => {
    const yaml =
      "packages:\n  - 'packages/*'\n\noverrides:\n" +
      "  '@agentback/core': ^0.9.0   # lockstep\n  lodash: ^4.17.21\n";
    writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), yaml);
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      yaml.replace("': ^0.9.0", "': ^0.10.0"),
    );
    expect(r.changed).toContain('pnpm-workspace.yaml:@agentback/core');
  });

  // The same package pinned twice at different versions: the LOWEST has to win
  // or the window narrows and the migrations in the gap never run.
  it('resolves `from` from the lowest pin across two YAML blocks', async () => {
    writeFileSync(
      path.join(cwd, 'pnpm-workspace.yaml'),
      "overrides:\n  '@agentback/core': ^0.7.0\n" +
        "\ncatalog:\n  '@agentback/core': ^0.9.0\n",
    );
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: true, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.from).toBe('0.7.0');
    expect(r.disagreement).toContain(
      'pnpm-workspace.yaml:catalog:@agentback/core',
    );
  });

  it('refuses a directory with no root package.json', async () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'abc-bare-'));
    mkdirSync(path.join(bare, 'packages', 'app'), {recursive: true});
    writeFileSync(
      path.join(bare, 'packages', 'app', 'package.json'),
      JSON.stringify({dependencies: {'@agentback/core': '^0.9.0'}}),
    );
    const {exec} = stubExec();
    try {
      await expect(
        runUpdate(
          {dryRun: true, force: false, help: false, to: '0.10.0'},
          {exec, cwd: bare, selfVersion: '0.10.0'},
        ),
      ).rejects.toThrow(/no package.json/);
    } finally {
      rmSync(bare, {recursive: true, force: true});
    }
  });

  it('writes no workspace file under --dry-run', async () => {
    const yaml = "overrides:\n  '@agentback/core': ^0.9.0\n";
    writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), yaml);
    sub('packages/app', {
      name: 'app',
      dependencies: {'@agentback/rest': '^0.9.0'},
    });
    const {exec} = stubExec();
    await runUpdate(
      {dryRun: true, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      yaml,
    );
    expect(readPkg('packages/app').dependencies['@agentback/rest']).toBe(
      '^0.9.0',
    );
  });

  // The kill-shot for gap 2: detection that reads only the root `src/**` sees a
  // fraction of a workspace app and reports "no advisories" on the grounds of
  // not having looked.
  it('detects an advisory whose trigger lives only in a workspace package', async () => {
    seed(cwd, {
      ...PKG,
      dependencies: {'@agentback/core': '^0.8.0'},
      workspaces: ['packages/*'],
    });
    sub(
      'packages/app',
      {name: 'app', dependencies: {'@agentback/mcp-http': '^0.8.0'}},
      'installMcpHttp(app, {eventStore: myStore});\n',
    );
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: true, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.findings.map(f => f.migration)).toContain('mcp-stateless-default');
  });

  it('reports no findings when no workspace package carries the trigger', async () => {
    seed(cwd, {
      ...PKG,
      dependencies: {'@agentback/core': '^0.8.0'},
      workspaces: ['packages/*'],
    });
    sub(
      'packages/app',
      {name: 'app', dependencies: {'@agentback/rest': '^0.8.0'}},
      'export class Nothing {}\n',
    );
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: true, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.findings).toEqual([]);
  });

  // The net: a pin the bump enumerator never saw must still fail the run.
  it('fails loudly when a stale pin survives the update', async () => {
    sub('services/api', {
      name: 'api',
      dependencies: {'@agentback/rest': '^0.9.0'},
    });
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: false, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.stale.map(s => s.name)).toEqual(['@agentback/rest']);

    const lines: string[] = [];
    expect(printUpdateReport(r, s => lines.push(s))).toBe(1);
    expect(lines.join('\n')).toContain('services');
    expect(lines.join('\n')).toContain('@agentback/rest');
  });

  it('runs no audit under --dry-run (nothing was written to check)', async () => {
    sub('services/api', {
      name: 'api',
      dependencies: {'@agentback/rest': '^0.9.0'},
    });
    const {exec} = stubExec();
    const r = await runUpdate(
      {dryRun: true, force: false, help: false, to: '0.10.0'},
      {exec, cwd, selfVersion: '0.10.0'},
    );
    expect(r.stale).toEqual([]);
  });
});

describe('printUpdateReport', () => {
  const base: UpdateReport = {
    from: '0.9.0',
    to: '0.10.0',
    changed: ['@agentback/core'],
    skipped: [],
    unparsed: [],
    disagreement: [],
    warnings: [],
    findings: [],
    stale: [],
    installed: true,
    dryRun: false,
  };

  it('renders the version transition and the bump count', () => {
    const lines: string[] = [];
    expect(printUpdateReport(base, s => lines.push(s))).toBe(0);
    expect(lines.join('\n')).toContain('0.9.0 → 0.10.0');
    expect(lines.join('\n')).toContain('Bumped 1 dependencies');
  });

  it('renders each finding with its migration id and action', () => {
    const lines: string[] = [];
    printUpdateReport(
      {
        ...base,
        findings: [
          {
            migration: 'm1',
            file: 'src/a.ts',
            line: 7,
            message: 'msg',
            action: 'fix it',
          },
        ],
      },
      s => lines.push(s),
    );
    const text = lines.join('\n');
    expect(text).toContain('[m1] src/a.ts:7');
    expect(text).toContain('→ fix it');
  });

  it('surfaces skipped ranges so they are not silently left behind', () => {
    const lines: string[] = [];
    printUpdateReport({...base, skipped: ['dependencies:@agentback/rest']}, s =>
      lines.push(s),
    );
    expect(lines.join('\n')).toContain('dependencies:@agentback/rest');
  });

  // A stale tree with no stale pins has nothing to "fix and re-run" — the same
  // run would reproduce byte-for-byte forever. The two halves get separate
  // instructions.
  it('tells a stale tree to install, and never to edit pins', () => {
    const lines: string[] = [];
    const code = printUpdateReport(
      {
        ...base,
        installHint: 'pnpm install',
        stale: [
          {
            site: 'node_modules/@agentback/core/package.json',
            name: '@agentback/core',
            found: '0.7.1',
          },
        ],
      },
      s => lines.push(s),
    );
    const text = lines.join('\n');
    expect(code).toBe(1);
    expect(text).toContain('Installed below target');
    expect(text).toContain('Run `pnpm install`');
    expect(text).not.toContain('Pinned below target');
    expect(text).not.toContain('carets cannot cross');
  });

  it('renders both halves, each with its own instruction', () => {
    const lines: string[] = [];
    printUpdateReport(
      {
        ...base,
        installHint: 'yarn install',
        stale: [
          {
            site: 'services/api/package.json',
            name: '@agentback/rest',
            found: '^0.7.1',
          },
          {
            site: 'node_modules/@agentback/core/package.json',
            name: '@agentback/core',
            found: '0.7.1',
          },
        ],
      },
      s => lines.push(s),
    );
    const text = lines.join('\n');
    expect(text).toContain('Pinned below target');
    expect(text).toContain('services/api/package.json');
    expect(text).toContain('Installed below target');
    expect(text).toContain('Run `yarn install` after fixing the pins above.');
  });
});
