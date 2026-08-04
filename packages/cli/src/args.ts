// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AgentError, ErrorCodes} from '@agentback/openapi';
import {TEMPLATES, capabilityNames, type TemplateName} from 'create-agentback';

export interface DeployArgs {
  target: 'vercel' | 'cloudflare';
  entry?: string;
  exportName?: string;
  prod: boolean;
  temporary: boolean;
  console: boolean;
  unsafePublicConsole: boolean;
  eject: boolean;
  force: boolean;
  dryRun: boolean;
  yes: boolean;
  verifyPath: string;
  help: boolean;
}

const VALUE_FLAGS = new Set(['--entry', '--export', '--verify-path']);
const BOOL_FLAGS = new Set([
  '--prod',
  '--temporary',
  '--console',
  '--unsafe-public-console',
  '--eject',
  '--force',
  '--dry-run',
  '--yes',
  '-h',
  '--help',
]);

function bad(message: string): never {
  throw new AgentError(message, {code: ErrorCodes.INVALID_INPUT});
}

export function parseDeployArgs(argv: string[]): DeployArgs {
  const [target, ...rest] = argv;
  if (!target)
    bad('deploy: missing target. Usage: agentback deploy vercel|cloudflare');

  const TARGETS: Record<string, 'vercel' | 'cloudflare'> = {
    vercel: 'vercel',
    cloudflare: 'cloudflare',
    cf: 'cloudflare',
    workers: 'cloudflare',
  };

  const resolved = TARGETS[target];
  if (!resolved)
    bad(`deploy: unknown target '${target}' (supported: vercel, cloudflare)`);

  const out: DeployArgs = {
    target: resolved,
    prod: false,
    temporary: false,
    console: false,
    unsafePublicConsole: false,
    eject: false,
    force: false,
    dryRun: false,
    yes: false,
    verifyPath: '/openapi.json',
    help: false,
  };

  for (let i = 0; i < rest.length; i++) {
    const f = rest[i];
    if (VALUE_FLAGS.has(f)) {
      const v = rest[++i];
      if (v === undefined) bad(`deploy: ${f} needs a value`);
      if (f === '--entry') out.entry = v;
      else if (f === '--export') out.exportName = v;
      else if (f === '--verify-path') out.verifyPath = v;
    } else if (BOOL_FLAGS.has(f)) {
      if (f === '--prod') out.prod = true;
      else if (f === '--temporary') out.temporary = true;
      else if (f === '--console') out.console = true;
      else if (f === '--unsafe-public-console') out.unsafePublicConsole = true;
      else if (f === '--eject') out.eject = true;
      else if (f === '--force') out.force = true;
      else if (f === '--dry-run') out.dryRun = true;
      else if (f === '--yes') out.yes = true;
      else if (f === '-h' || f === '--help') out.help = true;
    } else {
      bad(`deploy: unknown flag '${f}'`);
    }
  }
  return out;
}

export interface NewArgs {
  name: string;
  template: TemplateName;
  capabilities: string[];
  host?: {port?: number; host?: string; basePath?: string};
  help: boolean;
}

const NEW_VALUE_FLAGS = new Set([
  '--template',
  '-t',
  '--with',
  '--port',
  '--host',
  '--base-path',
]);
const EQ_FORM = /^--[a-z-]+=/;

export function parseNewArgs(argv: string[]): NewArgs {
  const out: NewArgs = {
    name: '',
    template: 'hybrid',
    capabilities: [],
    help: false,
  };
  const host: {port?: number; host?: string; basePath?: string} = {};
  const caps = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '-h' || f === '--help') {
      out.help = true;
    } else if (f === '--drizzle' || f === '--auth') {
      caps.add(f.slice(2));
    } else if (f === '-c' || f === '--console') {
      caps.add('console');
    } else if (NEW_VALUE_FLAGS.has(f) || EQ_FORM.test(f)) {
      // `--template rest` and `--template=rest` must both work: the `=` form is
      // supported by create-agentback's own CLI, and two entry points to the
      // same scaffolder disagreeing on flag syntax is a bug users hit once.
      const eq = f.indexOf('=');
      const flag = eq === -1 ? f : f.slice(0, eq);
      const v = eq === -1 ? argv[++i] : f.slice(eq + 1);
      if (v === undefined || v === '') bad(`new: ${flag} needs a value`);
      if (flag === '--template' || flag === '-t') {
        if (!(TEMPLATES as readonly string[]).includes(v))
          bad(
            `new: unknown template '${v}' (supported: ${TEMPLATES.join(', ')})`,
          );
        out.template = v as TemplateName;
      } else if (flag === '--with') {
        for (const c of v.split(',').filter(Boolean)) caps.add(c);
      } else if (flag === '--port') {
        const n = Number(v);
        if (!Number.isInteger(n))
          bad(`new: --port must be an integer, got '${v}'`);
        host.port = n;
      } else if (flag === '--host') {
        host.host = v;
      } else if (flag === '--base-path') {
        host.basePath = v;
      } else {
        bad(`new: unknown flag '${flag}'`);
      }
    } else if (f.startsWith('-')) {
      bad(`new: unknown flag '${f}'`);
    } else if (!out.name) {
      out.name = f;
    } else {
      bad(`new: unexpected argument '${f}'`);
    }
  }

  // Validate against the CHOSEN template, not the global set: capabilities are
  // per-template (`console` needs an HTTP server, so it is invalid for `mcp`).
  // Runs after the loop because `--with` may precede `--template` in argv.
  const valid = capabilityNames(out.template);
  for (const c of caps) {
    if (!valid.includes(c))
      bad(
        `new: unknown capability '${c}' for the ${out.template} template ` +
          `(supported: ${valid.join(', ')})`,
      );
  }
  out.capabilities = [...caps];

  if (!out.name && !out.help)
    bad(
      'new: missing name. Usage: agentback new <name> ' +
        '[--template hybrid|rest|mcp]\n' +
        'For the interactive wizard, run: npm create agentback',
    );
  if (Object.keys(host).length) out.host = host;
  return out;
}

export interface UpdateArgs {
  to?: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

/** `--to` takes an exact version; lockstep makes a range meaningless. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const out: UpdateArgs = {dryRun: false, force: false, help: false};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    const eq = f.indexOf('=');
    const flag = eq === -1 ? f : f.slice(0, eq);
    if (flag === '--to') {
      const v = eq === -1 ? argv[++i] : f.slice(eq + 1);
      if (v === undefined || v === '') bad('update: --to needs a value');
      if (!EXACT_VERSION_RE.test(v))
        bad(`update: --to needs an exact version like 0.10.0, got '${v}'`);
      out.to = v;
    } else if (f === '--dry-run') {
      out.dryRun = true;
    } else if (f === '--force') {
      out.force = true;
    } else if (f === '-h' || f === '--help') {
      out.help = true;
    } else {
      bad(`update: unknown flag '${f}'`);
    }
  }
  return out;
}
