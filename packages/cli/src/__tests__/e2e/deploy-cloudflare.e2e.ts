// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {main} from '../../cli.js';

const RUN = process.env.ABC_E2E_CF === '1';

describe.skipIf(!RUN)('deploy cloudflare (e2e, credential-gated)', () => {
  it('deploys a fixture and serves /openapi.json', async () => {
    // Runs from the cf-app fixture dir (cwd must be packages/cli/fixtures/cf-app
    // after building, with a wrangler.toml and CLOUDFLARE_API_TOKEN set).
    // Requires wrangler installed + authenticated (`wrangler whoami` must pass).
    // Asserts a 0 exit code (generate + preflight + deploy + verify all passed).
    const code = await main(['deploy', 'cloudflare', '--yes', '--prod']);
    expect(code).toBe(0);
  }, 180_000);
});

// Secretless variant: `--temporary` provisions a throwaway Cloudflare preview
// account on the fly (no signup/token), so this needs NO CLOUDFLARE_API_TOKEN.
// It only works UNAUTHENTICATED — wrangler refuses `--temporary` when a session
// or CLOUDFLARE_API_TOKEN is present. CI runners are unauthenticated by default;
// to run locally, isolate the wrangler home first, e.g.:
//   env -u CLOUDFLARE_API_TOKEN HOME=$(mktemp -d) ABC_E2E_CF_TEMP=1 pnpm test ...
// Provisioning uses an anonymous proof-of-work endpoint that may rate-limit, so
// keep this NON-blocking in CI rather than a required check.
const RUN_TEMP = process.env.ABC_E2E_CF_TEMP === '1';

describe.skipIf(!RUN_TEMP)(
  'deploy cloudflare --temporary (e2e, secretless)',
  () => {
    it('deploys to a throwaway account and serves /openapi.json', async () => {
      // cwd must be the cf-app fixture; its builder (dist/index.js#buildApp) is
      // found by auto-detect, so no --entry needed.
      const code = await main(['deploy', 'cloudflare', '--temporary', '--yes']);
      expect(code).toBe(0);
    }, 180_000);
  },
);
