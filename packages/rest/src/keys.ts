// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey, type Context} from '@agentback/context';
import {DEFAULT_MIDDLEWARE_GROUP, MiddlewareGroups} from '@agentback/express';
import type {ConfirmationStore, IdempotencyStore} from '@agentback/common';
import type {RouteSchemas} from '@agentback/openapi';
import type {Request, Response} from 'express';
import type {RestServer} from './rest.server.js';

/**
 * Middleware-chain group names the {@link RestServer} mounts its built-in
 * middleware under. The chain's topological sort runs them `cors` →
 * `parseBody` → `middleware` (the default group for `app.middleware(fn)`).
 * Pass these to `app.middleware(fn, {upstreamGroups, downstreamGroups})` to
 * slot your own middleware relative to CORS and body parsing — e.g.
 * `{downstreamGroups: [RestMiddlewareGroups.PARSE_BODY]}` to run before bodies
 * are parsed, or `{upstreamGroups: [RestMiddlewareGroups.PARSE_BODY]}` after.
 */
export namespace RestMiddlewareGroups {
  /** CORS — runs first so preflights short-circuit before anything else. */
  export const CORS = MiddlewareGroups.CORS;
  /** Body parsing (`express.json()` et al). Runs after CORS. */
  export const PARSE_BODY = 'parseBody';
  /** Default group for user `app.middleware(fn)`. Runs after body parsing. */
  export const MIDDLEWARE = DEFAULT_MIDDLEWARE_GROUP;
}

export namespace RestBindings {
  // Application.server(RestServer) binds at `servers.${ClassName}` by default.
  export const SERVER = BindingKey.create<RestServer>('servers.RestServer');
  /**
   * Store backing `confirm:` routes. Optional — the server falls back to a
   * per-process in-memory store; bind a shared implementation (Redis, …)
   * for multi-instance deployments.
   */
  export const CONFIRMATION_STORE = BindingKey.create<ConfirmationStore>(
    'rest.confirmationStore',
  );
  /** Store backing `idempotency:` routes. Optional, same fallback rules. */
  export const IDEMPOTENCY_STORE = BindingKey.create<IdempotencyStore>(
    'rest.idempotencyStore',
  );
  /**
   * The raw Express {@link Request} for the in-flight request, bound into the
   * per-request context. Inject it (always optionally) for the escape-hatch
   * cases the typed input bundle can't model — multipart uploads, raw-stream
   * bodies, response streaming:
   *
   * ```ts
   * @inject(RestBindings.HTTP_REQUEST, {optional: true}) req?: Request
   * ```
   *
   * Prefer the validated slot-0 bundle for normal routes; reach for this only
   * when you genuinely need the raw transport object.
   */
  export const HTTP_REQUEST: BindingKey<Request> =
    BindingKey.create<Request>('rest.http.request');
  /** The raw Express {@link Response}. See {@link HTTP_REQUEST}. */
  export const HTTP_RESPONSE: BindingKey<Response> =
    BindingKey.create<Response>('rest.http.response');
}

/**
 * Binding tag for {@link RestDispatchHook} values. Bind a hook value and tag
 * it to wrap every dispatched request:
 *
 * ```ts
 * app
 *   .bind('hooks.audit')
 *   .to(myHook)
 *   .tag(REST_DISPATCH_HOOK_TAG);
 * ```
 *
 * Hooks compose as an onion in **bind order** — the first-bound hook is the
 * outermost. They wrap the whole per-request pipeline (authentication,
 * authorization, validation, the controller method), so denials and
 * validation failures surface to hooks as thrown errors. A subclass that
 * overrides `RestServer.dispatch` and calls `super.dispatch` runs *outside*
 * the hook chain (subclass first, then hooks, then the route invocation) —
 * the two seams compose.
 *
 * The resolved hook list is cached on the first dispatched request: hooks
 * must be bound before `app.start()`; later bindings are not picked up.
 */
export const REST_DISPATCH_HOOK_TAG = 'rest.dispatchHook';

/** Per-request info passed to a {@link RestDispatchHook}. */
export interface RestDispatchInfo {
  req: Request;
  res: Response;
  /** The controller class. */
  ctor: Function;
  methodName: string;
  schemas: RouteSchemas;
  /**
   * The per-request child context. Principals
   * (`SecurityBindings.USER` / `.CLIENT_APPLICATION`) are bound into it by
   * the wrapped pipeline, so hooks can read them after `next()` resolves
   * (optional get — unauthenticated routes bind nothing).
   */
  ctx?: Context;
}

/**
 * A cross-cutting wrapper around {@link RestServer.dispatch}. Call `next()`
 * exactly once to run the inner chain (remaining hooks, then the route);
 * return its result (possibly transformed) or rethrow its errors.
 */
export type RestDispatchHook = (
  info: RestDispatchInfo,
  next: () => Promise<unknown>,
) => Promise<unknown>;
