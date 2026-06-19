// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {inject} from '@agentback/core';
import {ACTOR_REGISTRY} from './keys.js';
import type {ActorClass, ActorProxy, ActorRegistry} from './registry.js';

/**
 * A factory bound to one actor type: `accessor(id)` returns the typed proxy for
 * that identity. Injected by `@injectActor(ActorClass)`.
 */
export type ActorAccessor<T extends object> = (id: string) => ActorProxy<T>;

/**
 * Inject a typed actor accessor instead of `ACTOR_REGISTRY` or a hand-written
 * client class:
 *
 * ```ts
 * constructor(@injectActor(CartActor) private carts: ActorAccessor<CartActor>) {}
 * // ...
 * await this.carts(id).add(input, {requestId});
 * await this.carts(id).total({});
 * ```
 *
 * It resolves the registry lazily per call and returns
 * `(id) => registry.ref(ActorClass, id)`, so every call still routes through the
 * runtime (serialization, validation, rollback, idempotency). You still annotate
 * the parameter type — `ActorAccessor<CartActor>` — as with any `@inject`.
 */
export function injectActor<T extends object>(actorClass: ActorClass<T>) {
  return inject(
    ACTOR_REGISTRY,
    {decorator: '@injectActor'},
    (ctx): ActorAccessor<T> =>
      (id: string) =>
        ctx.getSync<ActorRegistry>(ACTOR_REGISTRY).ref(actorClass, id),
  );
}
