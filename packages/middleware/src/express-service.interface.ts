// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import type {Express} from 'express';
import type {registerExpressMiddleware} from './middleware.js';
import type {ExpressRequestHandler} from './types.js';

/**
 * The Express host runtime capability `@agentback/rest`'s `RestServer` depends
 * on, behind a DI seam (`EXPRESS_SERVICE_KEY`) so the Express host is
 * injectable / omittable. Defined here in the NEUTRAL package (no express
 * runtime — express appears only as a type) so `RestServer` and the binding key
 * can reference it without dragging Express into an edge bundle or install. The
 * concrete `ExpressService` CLASS lives in `@agentback/express` and
 * `implements` this interface.
 */
export interface ExpressService {
  /** The Express application RestServer mounts `@api` routes + the chain onto. */
  readonly app: Express;
  /** The `express` module: app factory plus json/urlencoded/text/raw parsers. */
  readonly express: typeof import('express');
  /** The `cors` middleware factory. */
  readonly cors: typeof import('cors');
  /** Register an Express middleware into the LB chain on a context. */
  readonly registerExpressMiddleware: typeof registerExpressMiddleware;
  /** Resolve + group-sort the LB middleware chain into one Express handler. */
  readonly toExpressMiddleware: (ctx: Context) => ExpressRequestHandler;
}
