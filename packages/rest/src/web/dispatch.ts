// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {RouteMatch} from './router.js';

/**
 * The contract a host's FetchHost calls into: turn a matched route + the
 * incoming Web Request into a Response. `T` is the per-route payload the Router
 * stores; the per-request DI Context is derived inside the implementation.
 */
export type Dispatch<T> = (
  match: RouteMatch<T>,
  req: Request,
) => Promise<Response>;
