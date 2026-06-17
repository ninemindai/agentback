// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {
  applyCapability,
  capabilitiesRoot,
  CAPABILITIES,
  findCapability,
} from './capabilities.js';

export const TEMPLATES = ['hybrid', 'rest', 'mcp'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export interface ScaffoldOptions {
  /** App name — becomes the directory and package name. */
  name: string;
  /** Template to copy. Default 'hybrid'. */
  template?: TemplateName;
  /** Parent directory to create the app in. Default process.cwd(). */
  cwd?: string;
  /**
   * Version range written for `@agentback/*` deps. Defaults to a caret
   * range of this package's own version (templates carry `{{version}}`).
   */
  version?: string;
  /**
   * Mount the unified dev console (`@agentback/console`) at `/console` in place
   * of the standalone explorer/inspector mounts. Only valid for the `hybrid`
   * and `rest` templates (the stdio `mcp` template has no HTTP server).
   */
  console?: boolean;
  /**
   * HTTP host options baked into the scaffolded RestApplication config.
   * Rejected for the stdio `mcp` template (no REST server). Omitted keys fall
   * back to framework defaults (3000/127.0.0.1) and runtime PORT/HOST env.
   */
  host?: {port?: number; host?: string; basePath?: string};
  /** Opt-in capability add-ons (e.g. 'drizzle', 'auth', 'console'). */
  capabilities?: string[];
}

export interface ScaffoldResult {
  dir: string;
  template: TemplateName;
  files: string[];
}

const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Files that get `{{name}}` / `{{version}}` substitution after copy. */
const SUBSTITUTED = /\.(json|md|ts)$/;

/** Templates that have an HTTP server (and thus accept host options). */
const REST_TEMPLATES: readonly TemplateName[] = ['hybrid', 'rest'];

/** Render the `rest: {...}` config body from host options (no surrounding braces). */
function renderRestConfig(host?: ScaffoldOptions['host']): string {
  if (!host) return '';
  const parts: string[] = [];
  if (host.port !== undefined) parts.push(`port: ${host.port}`);
  if (host.host !== undefined) parts.push(`host: '${host.host}'`);
  if (host.basePath !== undefined) parts.push(`basePath: '${host.basePath}'`);
  return parts.length ? `rest: {${parts.join(', ')}}` : '';
}

/**
 * Fill a named anchor in a file, re-emitting the anchor so multiple capabilities
 * can stack at the same point. `kind: 'line'` targets `// {{agentback:tag}}`;
 * `kind: 'inline'` targets the inline block-comment form (used inside super()).
 */
function fillAnchor(
  text: string,
  tag: string,
  insert: string,
  kind: 'line' | 'inline' = 'line',
): string {
  if (kind === 'inline') {
    const re = new RegExp(`/\\* \\{\\{agentback:${tag}\\}\\} \\*/`);
    return text.replace(re, insert);
  }
  const re = new RegExp(`([ \\t]*)// \\{\\{agentback:${tag}\\}\\}`);
  return text.replace(
    re,
    (_m, indent: string) => `${indent}${insert}\n${indent}// {{agentback:${tag}}}`,
  );
}

/** Remove every remaining `{{agentback:*}}` anchor (line + inline forms). */
function stripAnchors(text: string): string {
  return text
    .replace(/^[ \t]*\/\/ \{\{agentback:[^}]+\}\}\n/gm, '')
    .replace(/\/\* \{\{agentback:[^}]+\}\} \*\//g, '');
}

function templatesRoot(): string {
  // dist/scaffold.js → ../templates (the templates dir ships uncompiled).
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'templates',
  );
}

function ownVersion(): string {
  const pkg = JSON.parse(
    readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'package.json',
      ),
      'utf8',
    ),
  ) as {version: string};
  return `^${pkg.version}`;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Copy a template into `<cwd>/<name>` with `{{name}}`/`{{version}}`
 * substitution. Refuses to overwrite an existing non-empty directory.
 */
export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const {name} = options;
  const template = options.template ?? 'hybrid';
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid app name '${name}' — must be a valid npm package name.`,
    );
  }
  if (!TEMPLATES.includes(template)) {
    throw new Error(
      `Unknown template '${template}'. Available: ${TEMPLATES.join(', ')}.`,
    );
  }
  const src = path.join(templatesRoot(), template);
  if (!existsSync(src)) {
    throw new Error(`Template directory missing: ${src}`);
  }
  // Scoped names: directory is the part after the slash.
  const dirName = name.includes('/') ? name.split('/')[1] : name;
  const dir = path.resolve(options.cwd ?? process.cwd(), dirName);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`Target directory ${dir} already exists and is not empty.`);
  }

  // Normalize the legacy `console: true` flag into the capability list, then
  // validate every capability against the template BEFORE copying anything so a
  // misconfiguration never leaves a partial directory behind. The per-capability
  // `applyCapability` re-checks (idempotent) once the copy has happened.
  const caps = [...(options.capabilities ?? [])];
  if (options.console && !caps.includes('console')) caps.push('console');
  for (const capName of caps) {
    const cap = findCapability(capName);
    if (!cap) {
      throw new Error(
        `Unknown capability '${capName}'. Available: ` +
          `${CAPABILITIES.map(c => c.name).join(', ')}.`,
      );
    }
    if (!cap.templates.includes(template)) {
      throw new Error(
        `Capability '${capName}' is not supported for the '${template}' ` +
          `template. Available templates: ${cap.templates.join(', ')}.`,
      );
    }
  }

  cpSync(src, dir, {recursive: true});

  // npm and pnpm strip a literal `.gitignore` from published tarballs, so the
  // templates ship it as `gitignore`; restore the leading dot after copying.
  const dotlessGitignore = path.join(dir, 'gitignore');
  if (existsSync(dotlessGitignore)) {
    renameSync(dotlessGitignore, path.join(dir, '.gitignore'));
  }

  // Console-capable templates ship a `src/main.console.ts` overlay. Swap it in
  // when console is selected; otherwise drop it.
  const consoleEntry = path.join(dir, 'src', 'main.console.ts');
  if (existsSync(consoleEntry)) {
    if (caps.includes('console')) {
      renameSync(consoleEntry, path.join(dir, 'src', 'main.ts'));
    } else {
      rmSync(consoleEntry);
    }
  }

  // Apply each capability: validate, merge deps, copy overlays, collect wiring.
  const wirings = caps.map(name =>
    applyCapability(name, {dir, template, capRoot: capabilitiesRoot()}),
  );

  // Host options → RestApplication config. Rejected for the stdio mcp template.
  if (options.host && !REST_TEMPLATES.includes(template)) {
    throw new Error(
      `host options are not supported for the '${template}' template; it has ` +
        `no HTTP server. Use --template ${REST_TEMPLATES.join(' or ')}.`,
    );
  }
  const appTsPath = path.join(dir, 'src', 'application.ts');
  if (existsSync(appTsPath)) {
    let appTs = readFileSync(appTsPath, 'utf8');
    const restConfig = renderRestConfig(options.host);
    if (restConfig) appTs = fillAnchor(appTs, 'rest-config', restConfig, 'inline');
    for (const w of wirings) {
      if (!w) continue;
      if (w.imports) appTs = fillAnchor(appTs, 'imports', w.imports);
      if (w.components) appTs = fillAnchor(appTs, 'components', w.components);
      if (w.registrations)
        appTs = fillAnchor(appTs, 'registrations', w.registrations);
    }
    appTs = stripAnchors(appTs);
    writeFileSync(appTsPath, appTs);
  }

  const version = options.version ?? ownVersion();
  const files = walk(dir);
  for (const rel of files) {
    if (!SUBSTITUTED.test(rel)) continue;
    const full = path.join(dir, rel);
    const text = readFileSync(full, 'utf8');
    const replaced = text
      .replaceAll('{{name}}', name)
      .replaceAll('{{version}}', version);
    if (replaced !== text) writeFileSync(full, replaced);
  }

  return {dir, template, files};
}

/** Detect the invoking package manager from npm's user-agent env. */
export function detectPackageManager(): 'pnpm' | 'yarn' | 'bun' | 'npm' {
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  return 'npm';
}
