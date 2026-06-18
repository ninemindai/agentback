// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey, type Context} from '@agentback/context';
// Import from express subpaths, NOT the package barrel: the barrel re-exports
// `express.server` (the real Express host), which would drag Express runtime
// (node:fs/node:net) onto the static graph and break edge bundling. These two
// leaves are Express-runtime-free (constants only).
import {DEFAULT_MIDDLEWARE_GROUP} from '@agentback/express/keys';
import {MiddlewareGroups} from '@agentback/express/types';
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
  /**
   * The raw Web {@link globalThis.Request} on the runtime-neutral fetch path
   * (Workers/Bun/Deno/`fetchHandler()`), the analogue of {@link HTTP_REQUEST}
   * for the Web surface. Inject with `{optional: true}` — it is absent on the
   * Express path.
   */
  export const WEB_REQUEST: BindingKey<globalThis.Request> =
    BindingKey.create<globalThis.Request>('rest.web.request');
  /**
   * Binding tag for runtime-neutral Web middleware entries (the `app.webMiddleware`
   * tier). The {@link RestServer.fetchHandler} collects every binding tagged with
   * this and folds the resolved `WebMiddlewareEntry` values into the Web onion,
   * group-sorted (parity with the Express chain). This is ADDITIVE — separate
   * from the Express `app.middleware` chain, which is unchanged.
   */
  export const WEB_MIDDLEWARE = 'rest.web.middleware';
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

/**
 * Per-request info passed to a {@link RestDispatchHook}. Runtime-neutral: it
 * carries a Web `Request` (not an Express `req`/`res`) so a hook runs at parity
 * on both the Express {@link RestServer.dispatch} path and the runtime-neutral
 * Web `RestHandler` path. A hook observes the request and wraps `next()`; it
 * does not own the `Response`. The one cross-cutting *write* a hook needs — a
 * response header — is expressed through the neutral {@link responseHeaders}
 * collector, which each surface flushes onto its own response object.
 */
export interface RestDispatchInfo {
  /**
   * A Web {@link globalThis.Request} view of the in-flight request — `method`,
   * `url`, and `headers` at parity on both surfaces (the Express path builds
   * this view from its `req`; the Web path already has it). Read-only for the
   * hook; the body is not consumed here.
   */
  request: globalThis.Request;
  /**
   * Neutral response-header collector. A hook may `set`/`append` headers it
   * wants on the outgoing response (e.g. the x402 gate's `x-payment-response`);
   * the dispatching surface flushes these onto its own response after the hook
   * chain resolves — Express via `res.setHeader`, Web by merging into the
   * `Response`. This is the only response *write* a hook gets — there is no
   * Express `res` on the neutral info.
   */
  responseHeaders: Headers;
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
