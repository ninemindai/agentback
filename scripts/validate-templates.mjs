// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Validate the `create-agentback` templates against the CURRENT
 * workspace packages: scaffold each template as a throwaway workspace member,
 * rewrite its `@agentback/*` deps to `workspace:*`, then build + test it.
 * This proves the templates aren't stale (don't reference changed APIs)
 * without needing the packages published.
 *
 * Registry-install validation (`npm install @agentback/* from npm`) is a
 * separate concern gated on the publish pipeline — see
 * docs/proposals/p2-1-publish-pipeline.md.
 *
 * Usage: `node scripts/validate-templates.mjs` (also run as a CI job).
 * Self-cleaning: removes the temp apps and restores pnpm-lock.yaml on exit.
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = ['rest', 'mcp', 'hybrid'];
const CLI = join(ROOT, 'packages/create-agentback/dist/cli.js');

const apps = TEMPLATES.map(t => ({
  template: t,
  name: `tmpl-check-${t}`,
  dir: join(ROOT, 'examples', `tmpl-check-${t}`),
}));

function run(cmd, args, cwd = ROOT) {
  execFileSync(cmd, args, {cwd, stdio: 'inherit'});
}

const LOCK = join(ROOT, 'pnpm-lock.yaml');
// Snapshot the lockfile bytes before we churn it, so cleanup restores the
// exact pre-run state (not `git checkout`, which would clobber other
// uncommitted lock changes).
const lockBefore = existsSync(LOCK) ? readFileSync(LOCK, 'utf8') : null;

function cleanup() {
  for (const app of apps) rmSync(app.dir, {recursive: true, force: true});
  if (lockBefore !== null) writeFileSync(LOCK, lockBefore);
}

function main() {
  if (!existsSync(CLI)) {
    throw new Error(
      `create-agentback is not built (${CLI}). Run \`pnpm build\` first.`,
    );
  }

  // 1. Scaffold each template as a workspace member (examples/* is globbed
  //    by pnpm-workspace.yaml).
  for (const app of apps) {
    rmSync(app.dir, {recursive: true, force: true});
    run(
      'node',
      [CLI, app.name, '--template', app.template],
      join(ROOT, 'examples'),
    );

    // 2. Point @agentback/* deps at the local workspace.
    const pkgPath = join(app.dir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    for (const field of ['dependencies', 'devDependencies']) {
      const deps = pkg[field];
      if (!deps) continue;
      for (const dep of Object.keys(deps)) {
        if (dep.startsWith('@agentback/')) deps[dep] = 'workspace:*';
      }
    }
    pkg.private = true; // never accidentally publishable
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }

  // 3. Wire the new members, then build + test each in isolation.
  run('pnpm', ['install', '--no-frozen-lockfile']);
  for (const app of apps) {
    console.log(`\n=== ${app.name} (${app.template}) ===`);
    run('pnpm', ['--filter', app.name, 'build']);
    run('pnpm', ['--filter', app.name, 'test']);
  }
  console.log(
    '\nAll templates build and pass their tests against the workspace.',
  );
}

try {
  main();
} finally {
  cleanup();
}
