// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// A plain DI service the CartActor injects. It exists to prove two things:
//  1. an @actor is a real DI service — the registry resolves it through its own
//     binding, so constructor @inject is honored;
//  2. domain errors thrown inside a turn (an unknown SKU, here) reach the caller
//     as an AgentError, which the REST server maps to a 400 the client can fix.
//     (A plain Error would be redacted to a generic 500 instead.)
// It also owns pricing, used by the cart's `checkout` command.

import {AgentError, ErrorCodes} from '@agentback/openapi';

// sku -> unit price in cents
const PRICES: Record<string, number> = {
  keyboard: 4999,
  mouse: 2999,
  monitor: 19999,
  'desk-mat': 1999,
};

export class Catalog {
  assertExists(sku: string): void {
    if (!(sku in PRICES)) {
      throw new AgentError(
        `Unknown SKU '${sku}'. Known SKUs: ${Object.keys(PRICES).join(', ')}.`,
        {code: ErrorCodes.INVALID_INPUT},
      );
    }
  }

  /** Unit price in cents. Throws (→ 400) for an unknown SKU. */
  priceOf(sku: string): number {
    this.assertExists(sku);
    return PRICES[sku]!;
  }
}
