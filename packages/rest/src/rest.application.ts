// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Application, ApplicationConfig} from '@agentback/core';
import type {Binding} from '@agentback/context';
// Subpath import (not the package barrel): the mixin and its transitive graph
// are Express-runtime-free, but the barrel re-exports `express.server`, which
// would pull Express (node:fs/node:net) onto the edge static graph.
import {MiddlewareMixin} from '@agentback/express/mixins/middleware.mixin';
import {loggers} from '@agentback/common';
import {RestServer} from './rest.server.js';
import {RestBindings} from './keys.js';
import type {RestServerConfig} from './types.js';
import type {WebMiddleware, WebMiddlewareEntry} from './web/middleware.js';

let webMiddlewareSeq = 0;

const log = loggers('agentback:rest:application');

/**
 * Host-neutral REST application base: pre-registers a {@link RestServer},
 * resolves its port/host from config + `PORT`/`HOST` env, exposes
 * `restController(...)` and the runtime-neutral `webMiddleware(...)`, and the
 * `restServer` accessor. Carries NO Express coupling — it extends the core
 * `Application` directly. {@link EdgeRestApplication} is this base wired to the
 * native (fetch) listener; {@link RestApplication} layers the Express
 * middleware chain on top via {@link MiddlewareMixin}.
 */
export class BaseRestApplication extends Application {
  constructor(config?: ApplicationConfig) {
    super(config);
    this.server(RestServer);
    // Resolve the RestServer config from three sources, highest precedence
    // first:
    //   1. the explicit `rest` config passed to the constructor (code intent)
    //   2. the PORT / HOST environment variables (12-factor deploys: a platform
    //      like Cloud Run / Heroku assigns $PORT and expects the app to bind it)
    //   3. RestServer's own defaults (port 3000, host 127.0.0.1)
    // Env only fills a field the caller LEFT UNSET, so an explicit
    // `new RestApplication({rest: {port}})` is never overridden by a stray env.
    const rest: RestServerConfig = {
      ...(config?.rest as RestServerConfig | undefined),
    };

    if (rest.port == null) {
      const envPort = process.env.PORT;
      if (envPort != null && envPort !== '') {
        const parsed = Number(envPort);
        // Accept 0 (ephemeral) through 65535; reject NaN / out-of-range so a
        // malformed PORT surfaces loudly instead of silently binding 3000.
        if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
          rest.port = parsed;
        } else {
          log.warn(
            'Ignoring invalid PORT env var %j (expected an integer 0-65535); ' +
              'falling back to the configured/default port',
            envPort,
          );
        }
      }
    }
    if (rest.host == null && process.env.HOST) rest.host = process.env.HOST;

    // Forward to the server's config binding — RestServer reads `@config()` off
    // its own `servers.RestServer` binding, so values left in APPLICATION_CONFIG
    // are ignored. Runs before any later `app.configure(RestBindings.SERVER)`,
    // so explicit reconfiguration still wins.
    if (Object.keys(rest).length > 0) {
      this.configure(RestBindings.SERVER).to(rest);
    }
  }

  /**
   * Bind a controller class. A thin, REST-flavored alias for
   * `Application.controller`: the `RestServer` discovers controllers by the core
   * `controller` tag (which `Application.controller` applies), so this exists for
   * call-site readability and parity with the other surface helpers — it adds no
   * separate tag. The class's own binding metadata (scope, key, namespace, tags)
   * is honored; a dual `@api` + `@mcpServer` class keeps its
   * `extensionFor(MCP_SERVERS)` membership, so one registration serves both REST
   * (via the `controller` tag) and MCP (via the extension membership).
   */
  restController<T>(ctor: new (...args: any[]) => T): Binding<T> {
    return super.controller<T>(ctor as never);
  }

  /**
   * Register a runtime-neutral {@link WebMiddleware} on the Web (`fetch`) path —
   * the neutral tier. It runs through {@link RestServer.fetchHandler}'s onion
   * (group-sorted, parity with the Express chain) on Workers/Deno/Bun and in
   * tests, fronting every `@api` route. A middleware that returns a `Response`
   * without calling `next` short-circuits the route handler.
   *
   * This is ADDITIVE and SEPARATE from `app.middleware(fn)` (the Express chain,
   * which is unchanged): use `app.middleware` for the Express server, and
   * `app.webMiddleware` for the runtime-neutral fetch path. Order via
   * `group`/`upstreamGroups`/`downstreamGroups` ({@link RestMiddlewareGroups}).
   *
   * Bindings must be registered before the first `fetchHandler()` call (the
   * onion is built lazily and cached on first request).
   */
  webMiddleware(
    middleware: WebMiddleware,
    opts: Omit<WebMiddlewareEntry, 'middleware'> = {},
  ): Binding<WebMiddlewareEntry> {
    const entry: WebMiddlewareEntry = {middleware, ...opts};
    return this.bind<WebMiddlewareEntry>(
      `rest.web.middleware.${webMiddlewareSeq++}`,
    )
      .to(entry)
      .tag(RestBindings.WEB_MIDDLEWARE);
  }

  get restServer(): Promise<RestServer> {
    return this.get<RestServer>(RestBindings.SERVER);
  }
}

/**
 * The default REST application: {@link BaseRestApplication} plus the Express
 * middleware chain (`app.middleware(...)` / `app.expressMiddleware(...)`) via
 * {@link MiddlewareMixin}. Hosted by Express (`listener: 'express'`, the
 * default). For an edge / fetch-only app that must not pull the Express
 * runtime, use {@link EdgeRestApplication} instead.
 *
 * `ExpressRestApplication` is exported as an explicit alias of this class.
 */
export class RestApplication extends MiddlewareMixin(BaseRestApplication) {}

export {RestApplication as ExpressRestApplication};

/**
 * Edge / fetch-only REST application: {@link BaseRestApplication} pinned to the
 * runtime-neutral native listener (`listener: 'native'`). `RestServer.start()`
 * mounts NO Express, so nothing pulls the Node-only `express`/`cors` runtime —
 * the app bundles clean for Cloudflare Workers / Bun / Deno and serves through
 * `fetchHandler()`. It deliberately does NOT expose `app.middleware` /
 * `app.expressMiddleware` (Express-only); use `app.webMiddleware` for the fetch
 * path. The native listener is forced regardless of any `rest.listener` passed.
 */
export class EdgeRestApplication extends BaseRestApplication {
  constructor(config?: ApplicationConfig) {
    super({
      ...config,
      rest: {
        ...(config?.rest as RestServerConfig | undefined),
        listener: 'native',
      },
    });
  }
}
