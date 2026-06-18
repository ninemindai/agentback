// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Request} from 'express';

/**
 * Transport-neutral view of an inbound request, exposing exactly what
 * authentication strategies read: the HTTP method, a case-insensitive header
 * accessor, and the parsed query parameters. Both the Express
 * ({@link fromExpressRequest}) and Web/WHATWG ({@link fromWebRequest}) surfaces
 * adapt their native request to this shape, so a single strategy contract feeds
 * both REST dispatch paths.
 */
export interface AuthRequest {
  /** Uppercase HTTP method (e.g. `GET`, `POST`). */
  readonly method: string;
  /**
   * Look up a single header value by name (case-insensitive). Returns the first
   * value when a header repeats, or `undefined` when absent.
   */
  headerValue(name: string): string | undefined;
  /**
   * Parsed query parameters. A repeated key yields a `string[]`; a single key
   * yields a `string`. Matches Express's `req.query` shape for string params.
   */
  readonly query: Record<string, string | string[] | undefined>;
}

/** First value of a possibly-repeated header, normalized to `string | undefined`. */
function firstHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Adapt an Express {@link Request} to the neutral {@link AuthRequest}. Header
 * lookups defer to Express's own case-insensitive `req.headers` map; query
 * params are passed through (Express already parses them to
 * `string | string[]`).
 */
export function fromExpressRequest(req: Request): AuthRequest {
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    headerValue(name: string): string | undefined {
      // Express lowercases incoming header keys in `req.headers`.
      return firstHeader(req.headers[name.toLowerCase()]);
    },
    query: req.query as Record<string, string | string[] | undefined>,
  };
}

/**
 * Adapt a WHATWG/global {@link globalThis.Request} to the neutral
 * {@link AuthRequest}. `Headers` lookups are already case-insensitive; query
 * params are parsed from the URL, collapsing a repeated key to a `string[]` and
 * a single key to a `string` (matching Express's `req.query` for string
 * params).
 */
export function fromWebRequest(req: globalThis.Request): AuthRequest {
  const url = new URL(req.url);
  const query: Record<string, string | string[] | undefined> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }
  return {
    method: (req.method ?? 'GET').toUpperCase(),
    headerValue(name: string): string | undefined {
      return req.headers.get(name) ?? undefined;
    },
    query,
  };
}
