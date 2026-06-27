// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {UsageEvent, UsageSink} from './types.js';

/**
 * Fans each usage event out to several sinks at once — the typical production
 * shape, where one event must reach both a durable **audit** sink (JSONL/Redis)
 * and a **billing** sink (e.g. Stripe metered billing) from a single record.
 * Child sinks run concurrently; if one rejects, the `record` rejects.
 */
export class CompositeUsageSink implements UsageSink {
  constructor(private readonly sinks: UsageSink[]) {}

  async record(event: UsageEvent): Promise<void> {
    await Promise.all(this.sinks.map(sink => sink.record(event)));
  }
}
