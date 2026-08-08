// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {ACTOR_RUNTIME, ActorRegistry} from '@agentback/actors';
import type {Application} from '@agentback/core';
import {DurableObjectActorRuntime} from './do-actor-runtime.js';
import type {ActorDoNamespace} from './do-surface.js';

export interface DurableObjectActorsOptions {
  /**
   * The Durable Object namespace binding for the class built by
   * `createActorDurableObject` — `env.<BINDING>` on Cloudflare/celld, or an
   * `InProcessDurableObjectHost` for tests and single-process runs.
   */
  namespace?: ActorDoNamespace;
  /**
   * A pre-wired runtime instead of a namespace — the shape
   * `createInProcessDoActorRuntime()` returns, where the object class's
   * definition loader already closes over the runtime's registrations.
   */
  runtime?: DurableObjectActorRuntime;
}

/**
 * Bind the actor runtime port to the Durable Objects adapter. The actor and
 * controller code don't change:
 *
 * ```ts
 * const runtime = installDurableObjectActors(app, {namespace: env.ACTORS});
 * app.service(CartActor);
 * ```
 *
 * A helper rather than a `Component` because the namespace binding is a
 * runtime value handed to the Worker (`env`), not something DI can construct.
 */
export function installDurableObjectActors(
  app: Application,
  options: DurableObjectActorsOptions,
): DurableObjectActorRuntime {
  const runtime =
    options.runtime ??
    (options.namespace
      ? new DurableObjectActorRuntime(options.namespace)
      : undefined);
  if (!runtime) {
    throw new Error(
      'installDurableObjectActors needs a `namespace` binding or a pre-wired `runtime`.',
    );
  }
  app.bind(ACTOR_RUNTIME).to(runtime);
  app.service(ActorRegistry);
  return runtime;
}
