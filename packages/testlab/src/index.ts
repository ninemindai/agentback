// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Test utilities for AgentBack. Vitest-friendly.
 *
 * For assertions use Vitest's built-in `expect`:
 *   `import {describe, it, expect} from 'vitest';`
 *
 * What's here:
 * - `sinon` re-export for spies / stubs / fake timers
 * - `createClientForHandler(handler)` / `createRestAppClient(app)` —
 *   typed supertest clients
 * - `givenHttpServerConfig()` — random-port HTTPS configs with bundled certs
 * - `inject()` / `stubServerRequest()` — @hapi/shot request/response stubs
 * - `TestSandbox` — per-test temp directory with mkdir/copy/reset helpers
 * - `validateApiSpec()` — OpenAPI 3 doc validator
 * - `toJSON()` — normalize objects for deep-equal comparisons
 * - `skipIf()` / `skipOnTravis()` — conditional test skipping
 *
 * @packageDocumentation
 */

export * from './client.js';
export * from './http-error-logger.js';
export * from './http-server-config.js';
export * from './request.js';
export * from './shot.js';
export * from './sinon.js';
export * from './skip.js';
export * from './test-sandbox.js';
export * from './to-json.js';
export * from './validate-api-spec.js';
