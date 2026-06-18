// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {QuotaService} from './types.js';

export interface InMemoryQuotaOptions {
  /** Per-principal unit ceiling. A principal absent from the map is unlimited. */
  limits?: Record<string, number>;
}

/**
 * Default {@link QuotaService}: per-principal cumulative unit counters checked
 * against a static limit map. Unlimited for any principal without a limit. A
 * windowed/durable quota (daily caps, prepaid credit) is a downstream
 * implementation of the same interface.
 */
export class InMemoryQuotaService implements QuotaService {
  private readonly limits: Record<string, number>;
  private readonly used = new Map<string, number>();

  constructor(opts: InMemoryQuotaOptions = {}) {
    this.limits = opts.limits ?? {};
  }

  check(principalId: string): {allowed: boolean; remaining?: number} {
    const limit = this.limits[principalId];
    if (limit === undefined) return {allowed: true};
    const remaining = Math.max(0, limit - (this.used.get(principalId) ?? 0));
    return {allowed: remaining > 0, remaining};
  }

  consume(principalId: string, units: number): void {
    this.used.set(principalId, (this.used.get(principalId) ?? 0) + units);
  }
}
