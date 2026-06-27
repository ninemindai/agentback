// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Request, RequestHandler, Response} from 'express';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type IRateLimiterStoreOptions,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';

export interface McpToolRateLimitOptions {
  /** Default points (calls) per window for any tool. Default 60. */
  points?: number;
  /** Window length in seconds. Default 60. */
  durationSecs?: number;
  /** Block a (caller, tool) bucket for N secs once exceeded. Default 0. */
  blockSecs?: number;
  /** Per-tool overrides keyed by tool name. */
  perTool?: Record<
    string,
    {points: number; durationSecs?: number; blockSecs?: number}
  >;
  /**
   * Caller key for bucketing. Default: the authenticated `req.auth.clientId`
   * (set by the framework auth guard / OAuth), else the client IP.
   */
  keyGenerator?: (req: Request) => string;
  /** ioredis-compatible client; when set, buckets are stored in Redis. */
  store?: unknown;
  /** Key namespace in the store. Default `'mcp-tool'`. */
  keyPrefix?: string;
}

const DEFAULT_BUCKET = '<default>';

interface JsonRpcCall {
  method?: string;
  params?: {name?: string};
  id?: unknown;
}

/**
 * Per-tool, per-caller rate limiting for MCP-over-HTTP. Reads the JSON-RPC body
 * (must run after `express.json()`); only `tools/call` requests are limited,
 * each tool getting its own bucket per caller. Responds 429 with a JSON-RPC
 * error + `Retry-After` when exceeded; store failures fail open.
 */
export function toolRateLimitMiddleware(
  options: McpToolRateLimitOptions = {},
): RequestHandler {
  const prefix = options.keyPrefix ?? 'mcp-tool';
  const duration = options.durationSecs ?? 60;
  const block = options.blockSecs ?? 0;

  const make = (
    name: string,
    points: number,
    dur: number,
    blk: number,
  ): RateLimiterAbstract => {
    const base: IRateLimiterStoreOptions = {
      storeClient: options.store,
      points,
      duration: dur,
      blockDuration: blk,
      keyPrefix: `${prefix}:${name}`,
    };
    return options.store
      ? new RateLimiterRedis(base)
      : new RateLimiterMemory(base);
  };

  const limiters = new Map<string, RateLimiterAbstract>();
  limiters.set(
    DEFAULT_BUCKET,
    make(DEFAULT_BUCKET, options.points ?? 60, duration, block),
  );
  for (const [tool, o] of Object.entries(options.perTool ?? {})) {
    limiters.set(
      tool,
      make(tool, o.points, o.durationSecs ?? duration, o.blockSecs ?? block),
    );
  }

  const callerKey =
    options.keyGenerator ??
    ((req: Request) =>
      (req as Request & {auth?: {clientId?: string}}).auth?.clientId ??
      req.ip ??
      'anon');

  return (req: Request, res: Response, next) => {
    const body = req.body as JsonRpcCall | undefined;
    const tool = body?.params?.name;
    if (body?.method !== 'tools/call' || typeof tool !== 'string') {
      next();
      return;
    }
    const limiter = limiters.get(tool) ?? limiters.get(DEFAULT_BUCKET)!;
    limiter.consume(`${callerKey(req)}:${tool}`, 1).then(
      () => next(),
      err => {
        if (err instanceof RateLimiterRes) {
          res.set('Retry-After', String(Math.ceil(err.msBeforeNext / 1000)));
          res.status(429).json({
            jsonrpc: '2.0',
            error: {
              code: -32029,
              message: `Rate limit exceeded for tool '${tool}'`,
            },
            id: body?.id ?? null,
          });
          return;
        }
        // Store failure (e.g. Redis down) — fail open.
        next();
      },
    );
  };
}
