// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {getRequestListener} from '@hono/node-server';
import type {FetchHost} from './fetch.js';

/**
 * Adapt a {@link FetchHost} to a Node `http` request listener via
 * `@hono/node-server`, which owns the Node↔Web conversion: Set-Cookie
 * multiplicity, client-abort wiring, HEAD, content-length, and stream errors.
 * Mount the returned listener with `http.createServer(...)`.
 */
export function createNodeListener(host: FetchHost) {
  return getRequestListener((req: Request) => host.fetch(req));
}
