// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/
//
// INVARIANT: @agentback/rest declares sideEffects:false for edge tree-shaking —
// no module in this package may have import-time side effects (loggers/Symbol.for/
// const-init are fine; reflect-metadata, global patches, and load-time decorator
// registration are NOT).

import {readFile} from 'node:fs/promises';
import {join, normalize} from 'node:path';

import type {AssetSource} from './asset-source.js';

const MIME: Record<string, string> = {
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  cjs: 'application/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  eot: 'application/vnd.ms-fontobject',
};

/**
 * Return an {@link AssetSource} that reads static files from `dir` on the
 * local filesystem.
 *
 * `suffix` is the path segment after the registered prefix — e.g. for a
 * prefix of `/explorer/assets` and a request to `/explorer/assets/main.js`,
 * `suffix` is `/main.js`. Returns `undefined` when the file is not found or
 * when the suffix would escape `dir` (path-traversal guard).
 *
 * Intended for bundled UI assets shipped alongside packages
 * (`context-explorer`, `rest-explorer`, etc.) — these assets are immutable
 * per build so a `cache-control: public, max-age=31536000, immutable` header
 * is set. When serving from a package in `node_modules`, the assets do not
 * change until the package is upgraded.
 *
 * **Edge note**: This function uses `node:fs` and is not available in
 * Cloudflare Workers or other edge runtimes. Use `fromCdn` for edge deploys.
 */
export function fromDisk(dir: string): AssetSource {
  // Normalise once so every call starts from a clean base.
  const base = dir.endsWith('/') ? dir : dir + '/';

  return async (suffix: string): Promise<globalThis.Response | undefined> => {
    // Strip the leading slash(es), then normalize to a clean relative path.
    const rel = normalize(suffix.replace(/^\/+/, ''));
    // Reject traversal attempts ('..') and bare-directory requests ('.').
    if (rel === '.' || rel.startsWith('..')) return undefined;

    const target = join(base, rel);
    // Double-guard: the resolved path must remain inside `base`.
    if (!target.startsWith(base)) return undefined;

    try {
      const data = await readFile(target);
      const ext = rel.split('.').pop()?.toLowerCase() ?? '';
      const contentType = MIME[ext] ?? 'application/octet-stream';
      return new globalThis.Response(data, {
        headers: {
          'content-type': contentType,
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return undefined;
    }
  };
}
