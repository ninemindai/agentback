// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey, type Context} from '@agentback/context';
import type {ConfirmationStore, IdempotencyStore} from '@agentback/common';
import type {RouteSchemas} from '@agentback/openapi';
import type {Request, Response} from 'express';
import type {RestServer} from './rest.server.js';

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
}

export const REST_CONTROLLER_TAG = 'restController';

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
