// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Examples test against `src` like a standalone downstream app — vitest
// transpiles the TypeScript on the fly via esbuild, importing the workspace
// packages from their built `dist/`. (The monorepo's package tests run against
// `dist/` instead; see the root vitest.config.ts.)
import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
    globals: false,
    watch: false,
  },
});
