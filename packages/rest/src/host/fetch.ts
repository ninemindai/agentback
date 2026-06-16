// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Router} from '../web/router.js';
import type {Dispatch} from '../web/dispatch.js';

/** A runtime-neutral request handler: the unit every host adapter wraps. */
export interface FetchHost {
  fetch(req: Request): Promise<Response>;
}

export interface FetchHostOptions<T> {
  router: Router<T>;
  /** Called with the matched route + the incoming request; returns the body. */
  dispatch: Dispatch<T>;
  /** Produced when the router has no match. Defaults to a flat 404 envelope. */
  notFound?: (req: Request) => Response | Promise<Response>;
}

function defaultNotFound(): Response {
  return Response.json(
    {code: 'not_found', message: 'Not Found'},
    {status: 404},
  );
}

/**
 * Compose a {@link Router} and a {@link Dispatch} into a {@link FetchHost}.
 * On Workers/Deno/Bun you export `host.fetch`; in tests you call it directly
 * with a `Request` and assert the `Response`. The 404 default mirrors the flat
 * `{code, message}` system error-envelope shape; AgentBack overrides `notFound`
 * with `buildErrorEnvelope` in a later part.
 */
export function createFetchHost<T>(opts: FetchHostOptions<T>): FetchHost {
  const notFound = opts.notFound ?? defaultNotFound;
  return {
    async fetch(req: Request): Promise<Response> {
      const {pathname} = new URL(req.url);
      const match = opts.router.match(req.method, pathname);
      if (!match) return notFound(req);
      return opts.dispatch(match, req);
    },
  };
}
