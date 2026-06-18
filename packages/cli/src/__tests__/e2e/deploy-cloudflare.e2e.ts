// Copyright (c) 2024 AgentBack contributors. MIT License.

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
