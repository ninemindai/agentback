// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Application, ApplicationConfig} from '@agentback/core';
import {MiddlewareMixin} from '@agentback/express';
import {loggers} from '@agentback/common';
import {RestServer} from './rest.server.js';
import {RestBindings, REST_CONTROLLER_TAG} from './keys.js';
import type {RestServerConfig} from './types.js';

const log = loggers('agentback:rest:application');

/**
 * Convenience Application subclass that pre-registers a RestServer, tags
 * controllers so the REST server can discover them at start, and exposes
 * `app.middleware(...)` / `app.expressMiddleware(...)` for registering
 * Express middleware that runs through the framework's middleware chain
 * before every route handler.
 */
export class RestApplication extends MiddlewareMixin(Application) {
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
   * Bind a controller class — delegates to Application.controller and adds
   * the REST tag so RestServer mounts its routes on start.
   */
  restController<T>(ctor: new (...args: any[]) => T): void {
    super.controller(ctor as never);
    this.bind(`controllers.${ctor.name}`)
      .toClass(ctor as never)
      .tag(REST_CONTROLLER_TAG);
  }

  get restServer(): Promise<RestServer> {
    return this.get<RestServer>(RestBindings.SERVER);
  }
}
