// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {NextFunction, Request, RequestHandler, Response} from 'express';
import type {RestApplication, RestServer} from '@agentback/rest';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type IRateLimiterStoreOptions,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';

export interface RateLimitOptions {
  /** Max requests (points) allowed per `durationSecs` window. Default 100. */
  points?: number;
  /** Window length in seconds. Default 60. */
  durationSecs?: number;
  /**
   * Once the limit is hit, block the key for this many seconds (0 = only
   * until the window rolls over). Default 0.
   */
  blockSecs?: number;
  /** Key namespace in the store. Default `'rl'`. */
  keyPrefix?: string;
  /** Derive the rate-limit key from the request. Default: the client IP. */
  keyGenerator?: (req: Request) => string;
  /** Return true to skip rate limiting for a request (e.g. health probes). */
  skip?: (req: Request) => boolean;
  /**
   * An ioredis-compatible client. When provided, limits are stored in Redis
   * (shared across instances); otherwise an in-process memory store is used.
   */
  store?: unknown;
  /** Emit `RateLimit-*` / `Retry-After` headers. Default true. */
  headers?: boolean;
  /** Status code when the limit is exceeded. Default 429. */
  statusCode?: number;
  /** Message returned in the error body when limited. Default 'Too many requests'. */
  message?: string;
}

type ResolvedOptions = Required<Omit<RateLimitOptions, 'store'>> & {
  store?: unknown;
};

const DEFAULTS: Omit<ResolvedOptions, 'store'> = {
  points: 100,
  durationSecs: 60,
  blockSecs: 0,
  keyPrefix: 'rl',
  keyGenerator: (req: Request) => req.ip ?? 'unknown',
  skip: () => false,
  headers: true,
  statusCode: 429,
  message: 'Too many requests',
};

function buildLimiter(opts: ResolvedOptions): RateLimiterAbstract {
  const base: IRateLimiterStoreOptions = {
    storeClient: opts.store,
    points: opts.points,
    duration: opts.durationSecs,
    blockDuration: opts.blockSecs,
    keyPrefix: opts.keyPrefix,
  };
  return opts.store ? new RateLimiterRedis(base) : new RateLimiterMemory(base);
}

function setRateLimitHeaders(
  res: Response,
  limit: number,
  rlRes: RateLimiterRes,
): void {
  res.set('RateLimit-Limit', String(limit));
  res.set('RateLimit-Remaining', String(Math.max(0, rlRes.remainingPoints)));
  res.set('RateLimit-Reset', String(Math.ceil(rlRes.msBeforeNext / 1000)));
}

/**
 * Build an Express rate-limiting middleware backed by `rate-limiter-flexible`.
 * Consumes one point per request keyed by {@link RateLimitOptions.keyGenerator}
 * (client IP by default). On the limit being exceeded it responds with the
 * configured status (429) and `Retry-After`; store errors fail open.
 */
export function createRateLimitMiddleware(
  options: RateLimitOptions = {},
): RequestHandler {
  const opts: ResolvedOptions = {...DEFAULTS, ...options};
  const limiter = buildLimiter(opts);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (opts.skip(req)) {
      next();
      return;
    }
    limiter.consume(opts.keyGenerator(req), 1).then(
      rlRes => {
        if (opts.headers) setRateLimitHeaders(res, opts.points, rlRes);
        next();
      },
      err => {
        if (err instanceof RateLimiterRes) {
          if (opts.headers) {
            setRateLimitHeaders(res, opts.points, err);
            res.set('Retry-After', String(Math.ceil(err.msBeforeNext / 1000)));
          }
          res.status(opts.statusCode).json({
            error: {statusCode: opts.statusCode, message: opts.message},
          });
          return;
        }
        // Store failure (e.g. Redis down) — fail open rather than 500.
        next();
      },
    );
  };
}

/**
 * Mount rate limiting on a running REST server's Express app. Call BEFORE
 * `app.start()` so it runs ahead of route handlers. Pass `path` to scope the
 * limit to a sub-path (e.g. `/api`).
 */
export function mountRateLimit(
  server: RestServer,
  options: RateLimitOptions & {path?: string} = {},
): void {
  const {path, ...rateOptions} = options;
  const mw = createRateLimitMiddleware(rateOptions);
  if (path) server.expressApp.use(path, mw);
  else server.expressApp.use(mw);
}

/** Convenience: resolve the REST server and mount rate limiting on it. */
export async function installRateLimit(
  app: RestApplication,
  options: RateLimitOptions & {path?: string} = {},
): Promise<void> {
  const server: RestServer = await app.restServer;
  mountRateLimit(server, options);
}

export {RateLimiterRes};
