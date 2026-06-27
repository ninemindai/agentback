// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Component} from '@agentback/core';
import {ExpressService} from './express-service.js';

/**
 * Registers the {@link ExpressService} singleton so it resolves at
 * {@link EXPRESS_SERVICE_KEY}. Add this component on a Node host that wants the
 * DI-provided Express runtime:
 *
 * ```ts
 * app.component(ExpressComponent);
 * ```
 *
 * Importing this module pulls the Node-only `ExpressService` (and thus Express)
 * onto the static graph — do NOT import it from an edge / `listener: 'native'`
 * entry point.
 */
export class ExpressComponent implements Component {
  services = [ExpressService];
}
