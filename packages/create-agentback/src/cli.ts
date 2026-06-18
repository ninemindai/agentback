#!/usr/bin/env node
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import * as p from '@clack/prompts';
import {
  detectPackageManager,
  scaffold,
  TEMPLATES,
  type ScaffoldOptions,
  type TemplateName,
} from './scaffold.js';
import {CAPABILITIES, capabilityNames} from './capabilities.js';

const CAP_NAMES = CAPABILITIES.map(c => c.name);

const USAGE = `create-agentback — scaffold an AgentBack app

Usage:
  npm create agentback <name> [-- --template ${TEMPLATES.join('|')}] [options]
  pnpm create agentback <name> [--template ${TEMPLATES.join('|')}] [options]

  Run with no name on a terminal for interactive mode.

Options:
  -t, --template <name>   Template: ${TEMPLATES.join(', ')} (default: hybrid)
  --with <caps>           Comma-separated capabilities: ${CAP_NAMES.join(', ')}
  --drizzle               Shorthand for --with drizzle
  --auth                  Shorthand for --with auth
  -c, --console           Shorthand for --with console
  --port <n>              REST server port (rest|hybrid)
  --host <h>              REST server host (rest|hybrid)
  --base-path <p>         REST base path (rest|hybrid)
  -i, --interactive       Prompt for any options not given on the command line
  -h, --help              Show this help
`;

function fail(msg: string): never {
  console.error(`error: ${msg}\n`);
  console.error(USAGE);
  process.exit(1);
}

const args = process.argv.slice(2);
let name: string | undefined;
let template: TemplateName | undefined;
const caps = new Set<string>();
const host: {port?: number; host?: string; basePath?: string} = {};
let forceInteractive = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '-t' || a === '--template') {
    template = args[++i] as TemplateName;
  } else if (a.startsWith('--template=')) {
    template = a.slice('--template='.length) as TemplateName;
  } else if (a === '--with') {
    for (const c of (args[++i] ?? '').split(',').filter(Boolean)) caps.add(c);
  } else if (a.startsWith('--with=')) {
    for (const c of a.slice('--with='.length).split(',').filter(Boolean))
      caps.add(c);
  } else if (a === '--drizzle') {
    caps.add('drizzle');
  } else if (a === '--auth') {
    caps.add('auth');
  } else if (a === '-c' || a === '--console') {
    caps.add('console');
  } else if (a === '-i' || a === '--interactive') {
    forceInteractive = true;
  } else if (a === '--port') {
    host.port = Number(args[++i]);
  } else if (a.startsWith('--port=')) {
    host.port = Number(a.slice('--port='.length));
  } else if (a === '--host') {
    host.host = args[++i];
  } else if (a.startsWith('--host=')) {
    host.host = a.slice('--host='.length);
  } else if (a === '--base-path') {
    host.basePath = args[++i];
  } else if (a.startsWith('--base-path=')) {
    host.basePath = a.slice('--base-path='.length);
  } else if (a.startsWith('-')) {
    fail(`unknown option '${a}'`);
  } else if (!name) {
    name = a;
  } else {
    fail(`unexpected argument '${a}'`);
  }
}

if (host.port !== undefined && Number.isNaN(host.port)) {
  fail('--port must be a number');
}

function cancel(): never {
  p.cancel('Cancelled.');
  process.exit(0);
}

// Prompt only for fields not already supplied via flags (skip-supplied). With
// no flags this is the full wizard; with some flags it fills the gaps.
async function interactive(): Promise<void> {
  p.intro('create-agentback');

  if (!name) {
    const iName = await p.text({
      message: 'App name',
      placeholder: 'my-service',
      validate: v => (v && v.trim() ? undefined : 'Name is required'),
    });
    if (p.isCancel(iName)) return cancel();
    name = iName.trim();
  }

  if (!template) {
    const iTemplate = await p.select({
      message: 'Template',
      options: TEMPLATES.map(t => ({value: t, label: t})),
      initialValue: 'hybrid' as TemplateName,
    });
    if (p.isCancel(iTemplate)) return cancel();
    template = iTemplate as TemplateName;
  }

  // Skip the add-ons prompt if any were supplied via flags (--drizzle/--with…).
  const available = capabilityNames(template);
  if (caps.size === 0 && available.length) {
    const iCaps = await p.multiselect({
      message: 'Add-ons (space to toggle, enter to confirm)',
      required: false,
      options: CAPABILITIES.filter(c => available.includes(c.name)).map(c => ({
        value: c.name,
        label: c.label,
      })),
    });
    if (p.isCancel(iCaps)) return cancel();
    for (const c of iCaps as string[]) caps.add(c);
  }

  if (
    host.port === undefined &&
    (template === 'rest' || template === 'hybrid')
  ) {
    const iPort = await p.text({
      message: 'Port (blank for default 3000)',
      placeholder: '3000',
      validate: v =>
        !v || /^\d+$/.test(v) ? undefined : 'Port must be a number',
    });
    if (p.isCancel(iPort)) return cancel();
    if (iPort) host.port = Number(iPort);
  }

  const ok = await p.confirm({message: `Scaffold '${name}' (${template})?`});
  if (p.isCancel(ok) || !ok) return cancel();
}

async function run(): Promise<void> {
  // --interactive forces the prompt flow; otherwise it auto-triggers only when
  // no name was given. Either way it runs only on a TTY (it can't prompt a pipe)
  // and only fills fields the flags left unset.
  if (forceInteractive && !process.stdin.isTTY) {
    fail('--interactive requires a terminal');
  }
  if ((forceInteractive || !name) && process.stdin.isTTY) {
    await interactive();
  }
  if (!name) fail('missing app name');

  const opts: ScaffoldOptions = {
    name,
    template,
    capabilities: [...caps],
    host: Object.keys(host).length ? host : undefined,
  };

  try {
    const result = scaffold(opts);
    const pm = detectPackageManager();
    const runCmd = pm === 'npm' ? 'npm run' : pm;
    const dirName = name.includes('/') ? name.split('/')[1] : name;
    console.log(
      `\nScaffolded '${name}' (${result.template} template) in ${result.dir}\n`,
    );
    if (caps.size) console.log(`Add-ons: ${[...caps].join(', ')}\n`);
    console.log('Next steps:');
    console.log(`  cd ${dirName}`);
    console.log(`  ${pm} install`);
    console.log(
      `  ${runCmd} build && ${pm === 'npm' ? 'npm start' : `${pm} start`}`,
    );
    console.log(`  ${pm} test\n`);
    if (caps.has('drizzle')) {
      console.log(
        'Drizzle: runs in-memory by default; set DATABASE_URL to use Postgres.\n',
      );
    }
    if (caps.has('auth')) {
      console.log(
        'Auth: set JWT_SECRET before deploying (a dev secret is used otherwise).\n',
      );
    }
  } catch (err) {
    fail((err as Error).message);
  }
}

await run();
