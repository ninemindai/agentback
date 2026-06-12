// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import type {Meter} from './meter.js';
import type {QuotaService, UsageSink} from './types.js';

export namespace MeteringBindings {
  /** The {@link Meter} the metered servers resolve to emit usage events. */
  export const METER = BindingKey.create<Meter>('metering.meter');
  /** The durable {@link UsageSink}. Defaults to in-memory. */
  export const SINK = BindingKey.create<UsageSink>('metering.sink');
  /** The {@link QuotaService} for `metered?` enforcement. */
  export const QUOTA = BindingKey.create<QuotaService>('metering.quota');
  /**
   * Optional provider of the active trace id, stamped onto every
   * {@link UsageEvent} — bind it to correlate billing with tracing
   * (`@agentback/extension-otel`'s `installOtel` binds
   * `getActiveTraceId` here automatically).
   */
  export const TRACE_ID_PROVIDER = BindingKey.create<() => string | undefined>(
    'metering.traceIdProvider',
  );
}
