// Bundles the React console shell into dist/client/main.js.
//
// src/client is excluded from tsconfig.json, so esbuild remains the bundler
// for the TSX; `tsconfig.client.json` provides semantic typechecking. esbuild
// reaches into each contributing tool's `./console`
// source TSX (resolved via the package `exports` map) to compose one SPA. The
// root `pnpm build` runs this via `pnpm -r run build:client`.

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

await build({
  entryPoints: [root + 'src/client/main.tsx'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: true,
  outfile: root + 'dist/client/main.js',
  logLevel: 'info',
});
