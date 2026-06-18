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

// Bare Node.js built-in names (without the node: prefix) used by CJS packages.
// These must be externalized alongside 'node:*' so that transitive CJS
// dependencies (multer, busboy, express, etc.) don't cause build failures
// when the worker is bundled with platform:'browser'.
const BARE_NODE_BUILTINS = [
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
  'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8',
  'vm', 'worker_threads', 'zlib',
];

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
      // 'node:*' covers the explicit-protocol form; BARE_NODE_BUILTINS covers
      // CJS transitive deps that still import without the node: prefix.
      external: ['node:*', ...BARE_NODE_BUILTINS],
      logLevel: 'silent',
    });
  } catch (err) {
    return {ok: false, message: `Worker bundle failed to compile: ${(err as Error).message}`};
  }
  // Use metafile.outputs (not inputs) so only imports that survive tree-shaking
  // are checked. Dead-code-eliminated node: imports (e.g. @agentback/rest's
  // `fromDisk` / node:fs when the worker only uses `fetchHandler`) are dropped
  // from outputs.imports even though they still appear in inputs.
  const nodeImports = new Set<string>();
  for (const output of Object.values(result.metafile?.outputs ?? {})) {
    for (const imp of (output as {imports?: Array<{path: string; kind: string}>}).imports ?? []) {
      if (imp.path.startsWith('node:')) nodeImports.add(imp.path);
    }
  }
  return scanImports([...nodeImports]);
}
