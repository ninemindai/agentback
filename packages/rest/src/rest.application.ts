// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Application, ApplicationConfig} from '@agentback/core';
import {MiddlewareMixin} from '@agentback/express';
import {RestServer} from './rest.server.js';
import {RestBindings, REST_CONTROLLER_TAG} from './keys.js';

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
    // The constructor's `rest` key is the ergonomic way to configure the
    // RestServer (`new RestApplication({rest: {port}})`). Forward it to the
    // server's config binding — otherwise it lands in APPLICATION_CONFIG and
    // is silently ignored, since RestServer reads `@config()` off its own
    // `servers.RestServer` binding. Runs before any later
    // `app.configure(RestBindings.SERVER)`, so explicit reconfiguration wins.
    if (config?.rest != null) {
      this.configure(RestBindings.SERVER).to(config.rest);
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
