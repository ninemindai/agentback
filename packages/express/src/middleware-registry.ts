// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Binding,
  BindingAddress,
  Constructor,
  Context,
  Provider,
} from '@agentback/core';
import {MiddlewareMixin} from './mixins/middleware.mixin.js';
import {
  ExpressMiddlewareFactory,
  ExpressRequestHandler,
  Middleware,
  MiddlewareBindingOptions,
} from './types.js';

/**
 * A context that allows middleware registration
 */
export interface MiddlewareRegistry {
  /**
   * Bind an Express middleware to this server context
   *
   * @example
   * ```ts
   * import myExpressMiddlewareFactory from 'my-express-middleware';
   * const myExpressMiddlewareConfig= {};
   * const myExpressMiddleware = myExpressMiddlewareFactory(myExpressMiddlewareConfig);
   * server.expressMiddleware('middleware.express.my', myExpressMiddleware);
   * // Or
   * server.expressMiddleware('middleware.express.my', [myExpressMiddleware]);
   * ```
   * @param key - Middleware binding key
   * @param middleware - Express middleware handler function(s)
   *
   */
  expressMiddleware(
    key: BindingAddress,
    middleware: ExpressRequestHandler | ExpressRequestHandler[],
    options?: MiddlewareBindingOptions,
  ): Binding<Middleware>;

  /**
   * Bind an Express middleware to this server context
   *
   * @example
   * ```ts
   * import myExpressMiddlewareFactory from 'my-express-middleware';
   * const myExpressMiddlewareConfig= {};
   * server.expressMiddleware(myExpressMiddlewareFactory, myExpressMiddlewareConfig);
   * ```
   * @param middlewareFactory - Middleware module name or factory function
   * @param middlewareConfig - Middleware config
   * @param options - Options for registration
   *
   * @typeParam CFG - Configuration type
   */
  expressMiddleware<CFG>(
    middlewareFactory: ExpressMiddlewareFactory<CFG>,
    middlewareConfig?: CFG,
    options?: MiddlewareBindingOptions,
  ): Binding<Middleware>;

  /**
   * Register a middleware function or provider class
   *
   * @example
   * ```ts
   * const log: Middleware = async (requestCtx, next) {
   *   // ...
   * }
   * server.middleware(log);
   * ```
   *
   * @param middleware - Middleware function or provider class
   * @param options - Middleware binding options
   */
  middleware(
    middleware: Middleware | Constructor<Provider<Middleware>>,
    options?: MiddlewareBindingOptions,
  ): Binding<Middleware>;
}

/**
 * Base Context that provides APIs to register middleware
 */
export abstract class BaseMiddlewareRegistry extends MiddlewareMixin(Context) {}
