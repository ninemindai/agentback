// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Request as ExpressRequest, RequestHandler} from 'express';
import type {AuthInfo} from '@modelcontextprotocol/server';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type IRateLimiterStoreOptions,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';

/**
 * What a {@link McpToolRateLimitOptions.keyGenerator} is handed. Deliberately
 * host-neutral — it carries what a bucket key is actually made of, not a
 * host-specific request object, so one generator works under both the Express
 * and fetch/edge mounts.
 */
export interface RateLimitCaller {
  /**
   * The validated principal, when the endpoint authenticates. **Note:** under
   * OAuth, `authInfo.clientId` is the client _application_ id, shared by every
   * end user signing in through that app — bucketing on it throttles the app,
   * not the user, so one noisy user starves every other user of that client.
   * Key on your IdP's subject claim (often `extra.sub`) for per-user limits.
   */
  authInfo?: AuthInfo;
  /** Case-insensitive request header lookup. Available on every host. */
  header(name: string): string | undefined;
  /**
   * Client IP, resolved from the socket (honouring Express's `trust proxy`).
   * **`undefined` on the fetch/edge host**, which has no trustworthy source for
   * it: the only candidates are `X-Forwarded-For`-style headers, and keying a
   * limiter on a client-settable header means an attacker rotates it and is
   * never limited at all. Supply a `keyGenerator` reading your platform's
   * verified header (`CF-Connecting-IP`, `X-Vercel-Forwarded-For`, …) if you
   * need per-IP buckets there.
   */
  ip?: string;
}

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
   * Caller key for bucketing. Default: the authenticated `clientId`, else the
   * client IP where the host has one, else a single shared `anon` bucket.
   *
   * See {@link RateLimitCaller} for why the default is a compromise on both
   * axes — it throttles per OAuth _client app_ rather than per user, and the
   * fetch host has no IP to fall back to.
   */
  keyGenerator?: (caller: RateLimitCaller) => string;
  /** ioredis-compatible client; when set, buckets are stored in Redis. */
  store?: unknown;
  /** Key namespace in the store. Default `'mcp-tool'`. */
  keyPrefix?: string;
}

const DEFAULT_BUCKET = '<default>';

/** JSON-RPC error code for "rate limited" (server-defined range). */
const RATE_LIMITED = -32029;

interface JsonRpcCall {
  method?: string;
  params?: {name?: string};
  id?: unknown;
}

/** The outcome of checking one HTTP request against the limiters. */
export type RateLimitDecision =
  {ok: true} | {ok: false; tool: string; retryAfterSecs: number; id: unknown};

/**
 * Extract every `tools/call` in a request body, tallied per tool.
 *
 * **A JSON-RPC body may be an array.** The 2025-06-18 revision removed batching
 * from the spec, but the SDK transport still processes an array, and a limiter
 * that only understands the single-object shape sees `body.method === undefined`
 * on a batch and waves it through. That is a complete bypass — verified against
 * the shipping Express mount: with `points: 2`, a caller already answered 429
 * on single calls got a 200 and five more tool invocations by wrapping them in
 * an array. So batches are counted per element, not per request.
 */
function tallyToolCalls(body: unknown): {
  counts: Map<string, number>;
  id: unknown;
} {
  const counts = new Map<string, number>();
  let id: unknown = null;
  const entries: unknown[] = Array.isArray(body) ? body : [body];
  for (const entry of entries) {
    const call = entry as JsonRpcCall | undefined;
    if (call?.method !== 'tools/call') continue;
    const tool = call.params?.name;
    if (typeof tool !== 'string') continue;
    counts.set(tool, (counts.get(tool) ?? 0) + 1);
    // Echo the FIRST limited call's id, so a client correlating by id sees a
    // reply to something it actually sent.
    if (id === null) id = call.id ?? null;
  }
  return {counts, id};
}

/** A runtime-neutral limiter: one `check` per HTTP request. */
export interface ToolRateLimiter {
  check(body: unknown, caller: RateLimitCaller): Promise<RateLimitDecision>;
}

/**
 * Build the host-neutral per-tool, per-caller limiter.
 *
 * This is the decision half; the two hosts wrap it in their own idiom
 * ({@link toolRateLimitMiddleware} for Express, an inline check on the fetch
 * mount). It exists as a seam because the Express-only version was mounted
 * automatically by `installMcpHttp` on a host that could never run it — the
 * caller configured throttling and silently got none. Same shape as
 * `session.ts`: one contract, two hosts, no room to drift.
 */
export function createToolRateLimiter(
  options: McpToolRateLimitOptions = {},
): ToolRateLimiter {
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
    ((c: RateLimitCaller) => c.authInfo?.clientId ?? c.ip ?? 'anon');

  return {
    async check(body, caller) {
      const {counts, id} = tallyToolCalls(body);
      if (counts.size === 0) return {ok: true};
      const key = callerKey(caller);

      for (const [tool, n] of counts) {
        const limiter = limiters.get(tool) ?? limiters.get(DEFAULT_BUCKET)!;
        try {
          await limiter.consume(`${key}:${tool}`, n);
        } catch (err) {
          if (err instanceof RateLimiterRes) {
            // Points already consumed from earlier tools in this batch are not
            // refunded. That errs toward limiting, which is the right direction
            // for a control whose job is to say no.
            return {
              ok: false,
              tool,
              retryAfterSecs: Math.ceil(err.msBeforeNext / 1000),
              id,
            };
          }
          // Store failure (e.g. Redis down) — fail open.
          return {ok: true};
        }
      }
      return {ok: true};
    },
  };
}

/** The JSON-RPC error body returned on a 429, shared by both hosts. */
export function rateLimitErrorBody(tool: string, id: unknown) {
  return {
    jsonrpc: '2.0',
    error: {
      code: RATE_LIMITED,
      message: `Rate limit exceeded for tool '${tool}'`,
    },
    id: id ?? null,
  };
}

/**
 * Per-tool, per-caller rate limiting for MCP-over-HTTP on the **Express** host.
 * Reads the JSON-RPC body (must run after `express.json()`); only `tools/call`
 * requests are limited, each tool getting its own bucket per caller. Responds
 * 429 with a JSON-RPC error + `Retry-After` when exceeded; store failures fail
 * open.
 *
 * The fetch/edge host applies {@link createToolRateLimiter} directly — there is
 * no middleware chain there to mount this into.
 */
export function toolRateLimitMiddleware(
  options: McpToolRateLimitOptions = {},
): RequestHandler {
  const limiter = createToolRateLimiter(options);
  return (req, res, next) => {
    const authInfo = (req as ExpressRequest & {auth?: AuthInfo}).auth;
    limiter
      .check(req.body, {
        ...(authInfo ? {authInfo} : {}),
        header: name => {
          const v = req.headers[name.toLowerCase()];
          return Array.isArray(v) ? v[0] : v;
        },
        ...(req.ip ? {ip: req.ip} : {}),
      })
      .then(decision => {
        if (decision.ok) {
          next();
          return;
        }
        res.set('Retry-After', String(decision.retryAfterSecs));
        res.status(429).json(rateLimitErrorBody(decision.tool, decision.id));
      });
  };
}
