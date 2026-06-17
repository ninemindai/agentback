// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {main} from '../../cli.js';

const RUN = process.env.ABC_E2E_VERCEL === '1';

describe.skipIf(!RUN)('deploy vercel (e2e, credential-gated)', () => {
  it('deploys a fixture and serves /openapi.json', async () => {
    // Runs from a fixture app dir set by the harness (cwd). Requires a linked
    // Vercel project + auth. Asserts a 0 exit (deploy + verify passed).
    const code = await main(['deploy', 'vercel', '--yes']);
    expect(code).toBe(0);
  }, 180_000);
});
