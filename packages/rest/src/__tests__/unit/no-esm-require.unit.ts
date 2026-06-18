// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Regression guard for the v0.5.0 ERR_REQUIRE_ESM crash (fixed in 0.5.1).
 *
 * `rest.server` lazy-loads the optional CJS peers (`express`/`cors`) via
 * `createRequire`. It must NEVER `createRequire()` an `@agentback/*` workspace
 * package — those are ESM-only, so `require()`-ing them throws ERR_REQUIRE_ESM
 * on runtimes without require-of-ESM support (e.g. Vercel serverless). Neutral
 * workspace deps (`@agentback/middleware`) must be STATICALLY imported instead.
 *
 * This couldn't be caught by a boot test: Node ≥22.13 (our dev floor) permits
 * require-of-ESM, so the crash only surfaced on Vercel. A source-graph assertion
 * catches re-introduction regardless of the local runtime.
 */

import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// dist/__tests__/unit → dist
const restServerJs = resolve(here, '../../rest.server.js');

describe('rest.server never createRequire()s an ESM @agentback package', () => {
  it('lazy requires only CJS modules (no @agentback/* require)', () => {
    const src = readFileSync(restServerJs, 'utf8');
    // Any require('@agentback/...') / nodeRequire(...)('@agentback/...') is a bug.
    const bad = src.match(/require\w*\(\)?\(?\s*['"]@agentback\/[^'"]+['"]/g);
    expect(bad, `found require() of an ESM @agentback pkg: ${bad?.join(', ')}`).toBeNull();
  });
});
