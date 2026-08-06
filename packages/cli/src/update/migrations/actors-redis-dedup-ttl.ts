// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Finding, Migration} from '../migration.js';
import {rel} from './helpers.js';

/**
 * 0.10.0 validates `dedupTtlSeconds` in the `RedisActorRuntime` constructor.
 * A fractional or negative value used to be accepted and then raise from
 * `EXPIRE` mid-commit — after state and the dedup record were written; it now
 * fails loudly at startup instead. Flag the literals the constructor will
 * reject so the upgrade does not turn a latent misconfiguration into a boot
 * failure discovered at deploy time.
 */
export const actorsRedisDedupTtl: Migration = {
  id: 'actors-redis-dedup-ttl',
  version: '0.10.0',
  title: 'dedupTtlSeconds is validated at construction',
  detect(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.project().getSourceFiles()) {
      const text = file.getFullText();
      const bad = /dedupTtlSeconds\s*:\s*(-|\d*\.\d)/.exec(text);
      if (!bad) continue;
      findings.push({
        file: rel(ctx, file),
        line: text.slice(0, bad.index).split('\n').length,
        message: 'A fractional or negative dedupTtlSeconds.',
        action:
          'RedisActorRuntime now rejects this value at construction (it ' +
          'previously raised from EXPIRE mid-commit). Use whole seconds ' +
          'between 0 (no expiry) and MAX_DEDUP_TTL_SECONDS.',
      });
    }
    return findings;
  },
};
