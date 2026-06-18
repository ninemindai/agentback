// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {UsageEvent, UsageSink} from './types.js';

/**
 * Default {@link UsageSink}: keeps events in memory, deduplicated by
 * {@link UsageEvent.id}. Useful in dev, tests, and as the audit buffer behind
 * a flushing durable sink. Swap for a Redis/Kafka/DB sink in production.
 */
export class InMemoryUsageSink implements UsageSink {
  private readonly events = new Map<string, UsageEvent>();

  record(event: UsageEvent): void {
    if (!this.events.has(event.id)) this.events.set(event.id, event);
  }

  /** All recorded events, in insertion order. */
  all(): UsageEvent[] {
    return [...this.events.values()];
  }

  /** Events attributed to one principal id. */
  forPrincipal(id: string): UsageEvent[] {
    return this.all().filter(e => e.principal.id === id);
  }
}
