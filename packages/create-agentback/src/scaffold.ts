// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {cpSync, existsSync, readFileSync, readdirSync, writeFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

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

  cpSync(src, dir, {recursive: true});

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
