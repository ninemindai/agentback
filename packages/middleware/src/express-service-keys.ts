// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import type {ExpressService} from './express-service.interface.js';

/**
 * DI binding key for the {@link ExpressService} — the Express host runtime
 * `@agentback/rest`'s `RestServer` injects (`{optional: true}`) instead of
 * reaching for Express via `createRequire`.
 *
 * Lives in the neutral `@agentback/middleware` package and references only
 * `BindingKey` + the `ExpressService` TYPE, so importing the key never pulls the
 * Express runtime onto an edge bundle/install. The concrete `ExpressService`
 * CLASS (which value-imports express) lives in `@agentback/express`.
 */
export const EXPRESS_SERVICE_KEY = BindingKey.create<ExpressService>(
  'services.ExpressService',
);
