// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RouteMatch} from './router.js';

/**
 * The contract Part 2's RestHandler implements. Pinned here so Part 1's
 * FetchHost interface is consumer-validated before RestHandler exists.
 * `T` carries whatever the router stores per route (Part 2: the route's Zod
 * schemas + controller ref); the per-request DI Context is derived inside the
 * dispatch impl from the request, not threaded here.
 */
export type Dispatch<T> = (
  match: RouteMatch<T>,
  req: Request,
) => Promise<Response>;
