// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {nanoid} from 'nanoid';
import {statusOf} from './status.js';
import type {
  MeterOptions,
  UsageDescriptor,
  UsageEvent,
  UsageSink,
  UsageStatus,
} from './types.js';

/**
 * Builds {@link UsageEvent}s from descriptors and writes them to a
 * {@link UsageSink}. {@link observe} wraps a unit of work — timing it, emitting
 * an `ok` event on success or a status-mapped event on failure, and always
 * re-throwing — so the REST/MCP seams stay one-liners. Clock and id generator
 * are injectable for deterministic tests.
 */
export class Meter {
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly isoTime: (ms: number) => string;
  private readonly traceId: () => string | undefined;

  constructor(
    private readonly sink: UsageSink,
    opts: MeterOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.genId = opts.genId ?? (() => nanoid());
    this.isoTime = opts.isoTime ?? ((ms: number) => new Date(ms).toISOString());
    this.traceId = opts.traceIdProvider ?? (() => undefined);
  }

  /** Build and persist a single usage event. */
  async record(
    descriptor: UsageDescriptor & {status: UsageStatus; latencyMs: number},
  ): Promise<void> {
    const ms = this.now();
    const traceId = descriptor.traceId ?? this.traceId();
    const event: UsageEvent = {
      ...descriptor,
      id: this.genId(),
      at: this.isoTime(ms),
      units: descriptor.units ?? 1,
      ...(traceId ? {traceId} : {}),
    };
    await this.sink.record(event);
  }

  /**
   * Run `fn`, recording an event for the call. On success emits `ok` with the
   * measured latency; on failure emits the {@link statusOf}-mapped status and
   * re-throws the original error (metering never swallows the call's outcome).
   *
   * `descriptor` may be a thunk, resolved at record time — so a caller whose
   * principal only becomes known *during* `fn` (REST auth runs inside the
   * wrapped dispatch) can compute it after the fact.
   */
  async observe<T>(
    descriptor: UsageDescriptor | (() => UsageDescriptor),
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = this.now();
    const resolve = () =>
      typeof descriptor === 'function' ? descriptor() : descriptor;
    try {
      const result = await fn();
      await this.record({
        ...resolve(),
        status: 'ok',
        latencyMs: this.now() - start,
      });
      return result;
    } catch (err) {
      await this.record({
        ...resolve(),
        status: statusOf(err),
        latencyMs: this.now() - start,
      });
      throw err;
    }
  }
}
