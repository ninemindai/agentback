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

export const TEMPLATES = ['hybrid', 'rest', 'mcp'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** Templates with an HTTP server that can host the `/console` dev UI. */
export const CONSOLE_TEMPLATES: readonly TemplateName[] = ['hybrid', 'rest'];

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
}

export interface ScaffoldResult {
  dir: string;
  template: TemplateName;
  files: string[];
}

const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Files that get `{{name}}` / `{{version}}` substitution after copy. */
const SUBSTITUTED = /\.(json|md|ts)$/;

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
 * Replace the standalone explorer/inspector deps with `@agentback/console`,
 * which composes them into one mounted UI. Leaves `{{version}}` in place for
 * the substitution pass. Writes plain 2-space JSON (the scaffolded app, not a
 * linted workspace file).
 */
function retargetDepsToConsole(dir: string, template: TemplateName): void {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const drop =
    template === 'hybrid'
      ? ['@agentback/rest-explorer', '@agentback/mcp-inspector']
      : ['@agentback/rest-explorer'];
  const kept = Object.entries(pkg.dependencies ?? {}).filter(
    ([k]) => !drop.includes(k),
  );
  // Place `@agentback/console` ahead of the other @agentback deps.
  const at = kept.findIndex(([k]) => k.startsWith('@agentback/'));
  kept.splice(at < 0 ? kept.length : at, 0, [
    '@agentback/console',
    '{{version}}',
  ]);
  pkg.dependencies = Object.fromEntries(kept);
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

/** Point the README's URL hints at `/console` instead of the explorers. */
function retargetReadmeToConsole(dir: string): void {
  const readmePath = path.join(dir, 'README.md');
  if (!existsSync(readmePath)) return;
  const text = readFileSync(readmePath, 'utf8')
    .replace('REST + Swagger UI at /explorer', 'REST + dev console at /console')
    .replace(
      '`GET /explorer` (Swagger UI) · `GET /mcp-inspector` · `POST /mcp` (MCP HTTP)',
      '`GET /console` (dev console) · `POST /mcp` (MCP HTTP)',
    );
  writeFileSync(readmePath, text);
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
  if (options.console && !CONSOLE_TEMPLATES.includes(template)) {
    throw new Error(
      `--console is not supported for the '${template}' template; the console ` +
        `needs an HTTP server. Use --template ${CONSOLE_TEMPLATES.join(' or ')}.`,
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

  cpSync(src, dir, {recursive: true});

  // npm and pnpm strip a literal `.gitignore` from published tarballs, so the
  // templates ship it as `gitignore`; restore the leading dot after copying.
  const dotlessGitignore = path.join(dir, 'gitignore');
  if (existsSync(dotlessGitignore)) {
    renameSync(dotlessGitignore, path.join(dir, '.gitignore'));
  }

  // Console-capable templates ship a `src/main.console.ts` overlay next to the
  // default `src/main.ts`. With --console, swap it in and retarget deps + docs
  // from the standalone explorers to `@agentback/console`; otherwise drop it.
  const consoleEntry = path.join(dir, 'src', 'main.console.ts');
  if (existsSync(consoleEntry)) {
    if (options.console) {
      renameSync(consoleEntry, path.join(dir, 'src', 'main.ts'));
      retargetDepsToConsole(dir, template);
      retargetReadmeToConsole(dir);
    } else {
      rmSync(consoleEntry);
    }
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
