// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Run tests against the built dist/ so the same code path that
    // downstream apps see is what's exercised. Each package's tsconfig
    // emits tests under dist/__tests__.
    include: [
      'packages/*/dist/__tests__/**/*.{test,spec,unit,integration,acceptance,e2e}.js',
    ],
    exclude: ['**/node_modules/**', 'dist/**/__tests__/fixtures/**'],
    // Generous timeout for integration tests that spin up HTTP servers.
    testTimeout: 15_000,
    // Mocha-compatible: tests use `describe`/`it` imported from vitest.
    globals: false,
    // No watch mode by default for `vitest run`.
    watch: false,
    // Isolation per test file gives the same test-by-test isolation Mocha
    // had; tests don't leak module-level state.
    isolate: true,
    pool: 'threads',
  },
});
