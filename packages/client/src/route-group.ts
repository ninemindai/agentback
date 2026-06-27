// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  defineRoute,
  type HttpMethod,
  type RouteHandle,
  type RouteSchemas,
} from './define-route.js';

/**
 * A namespace for routes that share a path prefix. Mirrors the server-side
 * `@api({basePath: '/greet'})` so the client doesn't have to repeat the
 * prefix on every `defineRoute` call.
 *
 * Groups compose: `routeGroup('/api').group('/v1').get('/users', ...)`
 * registers `/api/v1/users`.
 */
export interface RouteGroup {
  readonly prefix: string;
  /** Build a child group whose prefix is `this.prefix` + `subPrefix`. */
  group(subPrefix: string): RouteGroup;
  /** Generic route builder — same as `defineRoute` but prepends the prefix. */
  route<S extends RouteSchemas = {}>(
    method: HttpMethod,
    path: string,
    schemas?: S,
  ): RouteHandle<S>;
  get<S extends RouteSchemas = {}>(path: string, schemas?: S): RouteHandle<S>;
  post<S extends RouteSchemas = {}>(path: string, schemas?: S): RouteHandle<S>;
  put<S extends RouteSchemas = {}>(path: string, schemas?: S): RouteHandle<S>;
  patch<S extends RouteSchemas = {}>(path: string, schemas?: S): RouteHandle<S>;
  delete<S extends RouteSchemas = {}>(
    path: string,
    schemas?: S,
  ): RouteHandle<S>;
  head<S extends RouteSchemas = {}>(path: string, schemas?: S): RouteHandle<S>;
}

/**
 * Create a route group that prepends `prefix` to every defined route's path.
 *
 * @example
 * ```ts
 * const greet = routeGroup('/greet');
 * const hello = greet.get('/hello/{name}', {path: HelloPath, response: Greeting});
 * // hello.path === '/greet/hello/{name}'
 * ```
 */
export function routeGroup(prefix: string): RouteGroup {
  const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;

  const compose = (path: string): string =>
    `${normalizedPrefix}${path.startsWith('/') ? path : `/${path}`}`;

  const route = <S extends RouteSchemas = {}>(
    method: HttpMethod,
    path: string,
    schemas?: S,
  ): RouteHandle<S> =>
    defineRoute(method, compose(path), (schemas ?? ({} as S)) as S);

  return {
    prefix: normalizedPrefix,
    group: subPrefix => routeGroup(compose(subPrefix)),
    route,
    get: (path, schemas) => route('GET', path, schemas),
    post: (path, schemas) => route('POST', path, schemas),
    put: (path, schemas) => route('PUT', path, schemas),
    patch: (path, schemas) => route('PATCH', path, schemas),
    delete: (path, schemas) => route('DELETE', path, schemas),
    head: (path, schemas) => route('HEAD', path, schemas),
  };
}
