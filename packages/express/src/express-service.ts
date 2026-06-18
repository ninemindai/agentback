// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingScope, ContextTags, injectable} from '@agentback/core';
import express, {type Express} from 'express';
import cors from 'cors';
import {registerExpressMiddleware, toExpressMiddleware} from './middleware.js';
import {EXPRESS_SERVICE_KEY} from './express-service-keys.js';

/**
 * DI-owned Express host. A singleton service that holds the Express `app` plus
 * the runtime helpers `@agentback/rest`'s `RestServer` needs to mount routes and
 * the LoopBack middleware chain: the `express` factory (with its `json` /
 * `urlencoded` / `text` / `raw` body parsers), `cors`, and the chain helpers.
 *
 * This is the injectable seam behind which the Express host lives, so it can be
 * provided, stubbed, or omitted via DI — the analogue of {@link CoreBindings.FETCH}
 * for the HTTP host. Modeled on `@factionvc/express`'s `ExpressService`.
 *
 * NODE-ONLY: this module value-imports `express`/`cors`, so it must never be on
 * the static graph of an edge (Cloudflare Workers) / `listener: 'native'` app.
 * It is registered via {@link ExpressComponent} only on the Node host; the key
 * lives in the import-safe `./express-service-keys.js`.
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: EXPRESS_SERVICE_KEY},
})
export class ExpressService {
  /** The Express application RestServer mounts `@api` routes + the chain onto. */
  readonly app: Express = express();
  /** The `express` module: app factory plus json/urlencoded/text/raw parsers. */
  readonly express = express;
  /** The `cors` middleware factory. */
  readonly cors = cors;
  /** Register an Express middleware into the LB chain on a context. */
  readonly registerExpressMiddleware = registerExpressMiddleware;
  /** Resolve + group-sort the LB middleware chain into one Express handler. */
  readonly toExpressMiddleware = toExpressMiddleware;
}
