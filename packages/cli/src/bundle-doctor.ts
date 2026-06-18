// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Diagnostic} from './deploy-target.js';

const DENY = new Set([
  'node:fs', 'node:fs/promises', 'node:path', 'node:net', 'node:http',
  'node:https', 'node:child_process', 'node:cluster', 'node:dgram', 'node:tls',
]);
// Allowed under Cloudflare's nodejs_compat; everything not in DENY is treated as
// allowed (npm packages bundle normally; only the DENY node: builtins fail).

export function scanImports(modules: string[]): Diagnostic {
  for (const m of modules) {
    // Match a denied builtin, ignoring a subpath after the base (node:fs/x).
    const denied = [...DENY].find(d => m === d || m.startsWith(d + '/'));
    if (denied) {
      const hint = denied.includes('fs') || denied.includes('path')
        ? ' (likely `serveStaticDir` on disk — switch the dev UI to the CDN `AssetSource`, or omit it for edge)'
        : ' (no Cloudflare Workers equivalent)';
      return {ok: false, message: `Edge-incompatible import: ${denied}${hint}`};
    }
  }
  return {ok: true, message: ''};
}

export async function runBundleDoctor(
  entryPath: string,
  esbuildImpl?: typeof import('esbuild'),
): Promise<Diagnostic> {
  const esbuild = esbuildImpl ?? (await import('esbuild'));
  let result;
  try {
    result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      external: ['node:*'],
      logLevel: 'silent',
    });
  } catch (err) {
    return {ok: false, message: `Worker bundle failed to compile: ${(err as Error).message}`};
  }
  const nodeImports = new Set<string>();
  for (const input of Object.values(result.metafile?.inputs ?? {})) {
    for (const imp of (input as {imports?: Array<{path: string}>}).imports ?? []) {
      if (imp.path.startsWith('node:')) nodeImports.add(imp.path);
    }
  }
  return scanImports([...nodeImports]);
}
