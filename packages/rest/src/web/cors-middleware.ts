// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {CorsOptions} from 'cors';
import {RestMiddlewareGroups} from '../keys.js';
import type {WebMiddleware, WebMiddlewareEntry} from './middleware.js';

const DEFAULT_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

/**
 * Resolve the value the `Access-Control-Allow-Origin` header should carry for
 * a given request origin, honoring the `cors` package's `origin` option shapes
 * on the Web path: `true`/`undefined` reflect the request origin (or `*` when
 * absent), `string` is a fixed origin, `string[]`/`RegExp`/`RegExp[]` are an
 * allow-list, `false` denies (returns `undefined`), and the function-form
 * callback is promisified and its decision honoured.
 *
 * Note: this is a small hand-rolled CORS for the runtime-neutral Web (`fetch`)
 * path — the `cors` npm package is Express-coupled (`(req, res, next)`), so it
 * can't run here. The Express path keeps using the real `cors` package.
 */
async function resolveOrigin(
  option: CorsOptions['origin'],
  requestOrigin: string | null,
): Promise<string | undefined> {
  if (option == null || option === true) return requestOrigin ?? '*';
  if (option === false) return undefined;
  if (typeof option === 'string') return option;
  if (option instanceof RegExp) {
    return requestOrigin && option.test(requestOrigin)
      ? requestOrigin
      : undefined;
  }
  if (Array.isArray(option)) {
    if (!requestOrigin) return undefined;
    const ok = option.some(o =>
      o instanceof RegExp ? o.test(requestOrigin) : o === requestOrigin,
    );
    return ok ? requestOrigin : undefined;
  }
  if (typeof option === 'function') {
    // Promisify the Node-style callback used by the `cors` package's
    // `CustomOrigin` form: `(origin, callback) => void`. The callback's second
    // argument is itself a `StaticOrigin`, so resolve it recursively.
    const resolved = await new Promise<CorsOptions['origin']>(
      (resolve, reject) => {
        option(requestOrigin ?? undefined, (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      },
    );
    return resolveOrigin(resolved, requestOrigin);
  }
  // Unknown shape — fail closed (deny) rather than accidentally reflecting.
  return undefined;
}

async function applyCorsHeaders(
  headers: Headers,
  opts: CorsOptions,
  req: Request,
): Promise<void> {
  const requestOrigin = req.headers.get('origin');
  const allowOrigin = await resolveOrigin(opts.origin, requestOrigin);
  if (allowOrigin === undefined) return;
  headers.set('access-control-allow-origin', allowOrigin);
  if (allowOrigin !== '*') headers.append('vary', 'Origin');
  if (opts.credentials) {
    headers.set('access-control-allow-credentials', 'true');
  }
  if (opts.exposedHeaders) {
    headers.set(
      'access-control-expose-headers',
      ([] as string[]).concat(opts.exposedHeaders).join(','),
    );
  }
}

/**
 * Build a runtime-neutral CORS {@link WebMiddleware} from the RestServer's
 * `cors` config (`true` for defaults, or a {@link CorsOptions} object). It
 * handles preflight (`OPTIONS` → 204 with the allow-* headers) by short-
 * circuiting (no `next`), and adds the origin/credentials/expose headers to
 * non-preflight responses. Mounted in the {@link RestMiddlewareGroups.CORS}
 * group so it runs first, mirroring the Express `registerBuiltinMiddleware`.
 */
export function createCorsWebMiddleware(
  cors: true | CorsOptions,
): WebMiddlewareEntry {
  const opts: CorsOptions = cors === true ? {} : cors;
  const middleware: WebMiddleware = async (req, _ctx, next) => {
    if (req.method === 'OPTIONS') {
      // Preflight: short-circuit with 204 + the CORS headers.
      const headers = new Headers();
      await applyCorsHeaders(headers, opts, req);
      const methods = opts.methods
        ? ([] as string[]).concat(opts.methods).join(',')
        : DEFAULT_METHODS;
      headers.set('access-control-allow-methods', methods);
      const reqHeaders =
        opts.allowedHeaders != null
          ? ([] as string[]).concat(opts.allowedHeaders).join(',')
          : req.headers.get('access-control-request-headers');
      if (reqHeaders) {
        headers.set('access-control-allow-headers', reqHeaders);
        headers.append('vary', 'Access-Control-Request-Headers');
      }
      if (opts.maxAge != null) {
        headers.set('access-control-max-age', String(opts.maxAge));
      }
      return new Response(null, {status: opts.optionsSuccessStatus ?? 204, headers});
    }
    const res = await next();
    // Add the CORS headers to the actual response. Clone headers (a Response's
    // headers can be immutable) so we can mutate them.
    const headers = new Headers(res.headers);
    await applyCorsHeaders(headers, opts, req);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  };
  return {middleware, group: RestMiddlewareGroups.CORS};
}
