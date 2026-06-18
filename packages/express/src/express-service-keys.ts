// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import type {ExpressService} from './express-service.js';

/**
 * DI binding key for the {@link ExpressService} — the Express host runtime
 * `@agentback/rest`'s `RestServer` injects (`{optional: true}`) instead of
 * reaching for Express via `createRequire`.
 *
 * This module is import-safe on the edge: it only references `BindingKey` and a
 * TYPE, so importing the key never pulls the Express runtime onto a Worker's
 * static graph. The {@link ExpressService} CLASS (which value-imports express)
 * lives in `./express-service.js` and must only be loaded on the Node host.
 */
export const EXPRESS_SERVICE_KEY = BindingKey.create<ExpressService>(
  'services.ExpressService',
);
