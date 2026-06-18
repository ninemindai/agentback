// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context} from '@agentback/context';
import {sortListOfGroups} from '@agentback/common';
import {RestBindings, RestMiddlewareGroups} from '../keys.js';

/**
 * A runtime-neutral middleware on the Web (`fetch`) path. Receives the incoming
 * Web {@link Request} and the app {@link Context}, and either returns a
 * {@link Response} directly (short-circuit — e.g. a CORS preflight or an auth
 * reject) or calls `next()` to invoke the rest of the onion (eventually the
 * route handler) and (optionally) post-processes the {@link Response} it
 * resolves to (e.g. adding headers).
 *
 * This is the neutral analogue of an Express middleware: it has no Express
 * coupling and runs on Workers/Deno/Bun/`fetchHandler()`. It is ADDITIVE — the
 * Express middleware chain (`app.middleware`) is untouched and continues to
 * front the Express server.
 */
export type WebMiddleware = (
  req: Request,
  ctx: Context,
  next: () => Promise<Response>,
) => Promise<Response>;

/**
 * A registered {@link WebMiddleware} plus the group/order metadata used to
 * topologically sort the onion — mirroring the Express chain's group ordering
 * so the two surfaces order identically. Reuse {@link RestMiddlewareGroups}
 * names (`cors`, `parseBody`, `middleware`) for parity.
 */
export interface WebMiddlewareEntry {
  middleware: WebMiddleware;
  /** Ordering group. Defaults to {@link RestMiddlewareGroups.MIDDLEWARE}. */
  group?: string;
  /** Groups that must run BEFORE this one (this entry is downstream of them). */
  upstreamGroups?: string[];
  /** Groups that must run AFTER this one (this entry is upstream of them). */
  downstreamGroups?: string[];
}

/**
 * Fold a sorted list of {@link WebMiddlewareEntry}s into an onion around
 * `core`: `entry0(req, ctx, () => entry1(req, ctx, () => … => core()))`. A
 * middleware that returns a {@link Response} without calling `next` short-
 * circuits the remaining onion (and `core`).
 *
 * Entries are ordered by {@link sortListOfGroups} (the same topological sort
 * the Express chain uses), NOT registration order.
 */
export function runWebOnion(
  entries: WebMiddlewareEntry[],
  req: Request,
  ctx: Context,
  core: () => Promise<Response>,
): Promise<Response> {
  const ordered = sortEntries(entries);
  const dispatch = (i: number): Promise<Response> => {
    if (i >= ordered.length) return core();
    const entry = ordered[i];
    return entry.middleware(req, ctx, () => dispatch(i + 1));
  };
  return dispatch(0);
}

/**
 * Order {@link WebMiddlewareEntry}s by their group using {@link sortListOfGroups}
 * — identical to the Express chain's ordering for the same groups. Each entry's
 * `upstreamGroups`/`downstreamGroups` contribute partial-order edges; entries
 * within a group keep registration order (stable).
 */
function sortEntries(entries: WebMiddlewareEntry[]): WebMiddlewareEntry[] {
  if (entries.length <= 1) return entries.slice();
  const groupOrders: string[][] = [];
  // Seed a baseline order so CORS → parseBody → middleware parity holds even
  // when an entry declares no explicit upstream/downstream relations.
  groupOrders.push([
    RestMiddlewareGroups.CORS,
    RestMiddlewareGroups.PARSE_BODY,
    RestMiddlewareGroups.MIDDLEWARE,
  ]);
  for (const e of entries) {
    const group = e.group ?? RestMiddlewareGroups.MIDDLEWARE;
    for (const up of e.upstreamGroups ?? []) groupOrders.push([up, group]);
    for (const down of e.downstreamGroups ?? []) groupOrders.push([group, down]);
  }
  const sorted = sortListOfGroups(...groupOrders);
  const rank = new Map(sorted.map((g, i) => [g, i]));
  const fallback = sorted.length;
  // Stable sort: entries in the same group preserve registration order.
  return entries
    .map((entry, idx) => ({entry, idx}))
    .sort((a, b) => {
      const ga = rank.get(a.entry.group ?? RestMiddlewareGroups.MIDDLEWARE);
      const gb = rank.get(b.entry.group ?? RestMiddlewareGroups.MIDDLEWARE);
      const ra = ga ?? fallback;
      const rb = gb ?? fallback;
      return ra === rb ? a.idx - b.idx : ra - rb;
    })
    .map(x => x.entry);
}

/**
 * Collect the {@link WebMiddlewareEntry}s bound into `ctx` under the
 * {@link RestBindings.WEB_MIDDLEWARE} tag, resolving each binding's value. Used
 * by {@link RestServer.fetchHandler} to build the onion once (lazily).
 */
export async function collectWebMiddleware(
  ctx: Context,
): Promise<WebMiddlewareEntry[]> {
  const bindings = ctx.findByTag<WebMiddlewareEntry>(RestBindings.WEB_MIDDLEWARE);
  return Promise.all(bindings.map(b => ctx.get<WebMiddlewareEntry>(b.key)));
}
