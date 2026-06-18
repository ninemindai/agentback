// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// A plain DI service the CartActor injects. It exists to prove two things:
//  1. an @actor is a real DI service — the registry resolves it through its own
//     binding, so constructor @inject is honored;
//  2. domain errors thrown inside a turn (here: an unknown SKU) reach the caller
//     as an AgentError, which the REST server maps to a 400 the client can fix.
//     (A plain Error would be redacted to a generic 500 instead.)

import {AgentError, ErrorCodes} from '@agentback/openapi';

const CATALOG = ['keyboard', 'mouse', 'monitor', 'desk-mat'] as const;

export class Catalog {
  private readonly skus = new Set<string>(CATALOG);

  assertExists(sku: string): void {
    if (!this.skus.has(sku)) {
      throw new AgentError(
        `Unknown SKU '${sku}'. Known SKUs: ${CATALOG.join(', ')}.`,
        {code: ErrorCodes.INVALID_INPUT},
      );
    }
  }
}
