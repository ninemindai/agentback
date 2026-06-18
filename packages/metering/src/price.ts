// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  MetadataAccessor,
  MetadataInspector,
  MethodDecoratorFactory,
} from '@agentback/metadata';

/**
 * Declared price for one route or tool call. `amount` is a decimal string in
 * `currency`; `units` (default 1) is the billable quantity each call records.
 */
export interface PriceSpec {
  /** Decimal amount per call, as a string for precision (e.g. `'0.001'`). */
  amount: string;
  /** ISO currency or token symbol: `'USD'`, `'USDC'`, … */
  currency: string;
  /** Billable units recorded per call. Default 1. */
  units?: number;
}

export const PRICE_KEY = MetadataAccessor.create<PriceSpec, MethodDecorator>(
  'metering:price',
);

/**
 * Parse a price shorthand: `'$0.001'` (USD) or `'0.01 USDC'`
 * (amount + currency/token symbol). A {@link PriceSpec} passes through.
 */
export function parsePrice(spec: string | PriceSpec): PriceSpec {
  if (typeof spec !== 'string') return spec;
  const dollars = /^\$(\d+(?:\.\d+)?)$/.exec(spec.trim());
  if (dollars) return {amount: dollars[1]!, currency: 'USD'};
  const pair = /^(\d+(?:\.\d+)?)\s+([A-Za-z][A-Za-z0-9]{1,11})$/.exec(
    spec.trim(),
  );
  if (pair) return {amount: pair[1]!, currency: pair[2]!.toUpperCase()};
  throw new Error(
    `@price('${spec}'): cannot parse — use '$<amount>' (USD), ` +
      `'<amount> <CURRENCY>', or a {amount, currency} object.`,
  );
}

/**
 * Price a route or tool: one decorator declares what a call costs.
 *
 * ```ts
 * @price('$0.001')
 * @tool('search_catalog', {input: SearchIn, output: SearchOut})
 * async search(input: z.infer<typeof SearchIn>) { … }
 * ```
 *
 * Two consumers read the declaration:
 *
 * - **Metering** (this package): the REST/MCP dispatch hooks stamp the price
 *   onto every {@link UsageEvent} (`cost` + `units`), so the usage log is
 *   billing-ready — `StripeMeterSink` / `StripeUsageReporter` forward it to
 *   metered billing with no extra wiring.
 * - **Payment gating** (`@agentback/payments`): `installPriceGate(app,
 *   {rail})` refuses unpaid calls to priced operations with a 402
 *   `payment_required` challenge (x402, MPP, …). Without a gate, `@price` is
 *   metering-only — record now, invoice later.
 */
export function price(spec: string | PriceSpec): MethodDecorator {
  const parsed = parsePrice(spec);
  return MethodDecoratorFactory.createDecorator<PriceSpec>(PRICE_KEY, parsed, {
    decoratorName: '@price',
  });
}

/** Look up the {@link PriceSpec} declared on a method, if any. */
export function getPrice(
  proto: object,
  methodName: string | symbol,
): PriceSpec | undefined {
  return MetadataInspector.getMethodMetadata<PriceSpec>(
    PRICE_KEY,
    proto,
    methodName as string,
  );
}
