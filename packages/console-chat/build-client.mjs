// Bundles the Dock component into dist/client/main.js (consumed by the
// console shell when it dynamically imports @agentback/console-chat/console).
//
// src/client is excluded from tsconfig.json; esbuild is the bundler for the
// TSX.  tsconfig.client.json provides semantic typechecking via
// `pnpm typecheck:client`.

import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

await build({
  entryPoints: [root + 'src/client/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  sourcemap: true,
  // React is provided by the console shell bundle; mark as external so the
  // Dock module can be loaded in the same SPA without a second React copy.
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  outfile: root + 'dist/client/main.js',
  logLevel: 'info',
});
