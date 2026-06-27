// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  BindingScope,
  type Application,
  type Binding,
  type BindingAddress,
  type BindingKey,
  type ValueOrPromise,
} from '@agentback/core';
import {DrizzleBindings} from './keys.js';

/**
 * Options for {@link registerDrizzle}.
 */
export interface RegisterDrizzleOptions {
  /**
   * Binding key for the client. Defaults to {@link DrizzleBindings.CLIENT}
   * (`datasources.drizzle`). Pass a distinct key (string or
   * `DrizzleBindings.datasource(name)`) to register multiple databases.
   */
  key?: BindingKey<unknown> | string;
  /**
   * Cleanup callback (typically `() => pool.end()`). When provided, a
   * lifecycle observer is registered so `app.stop()` invokes it. The callback
   * is guarded to run at most once, even across repeated start/stop cycles —
   * connection pools cannot be re-opened after `end()`.
   *
   * When omitted, no observer is registered (synchronous drivers such as
   * `better-sqlite3` may not need one).
   */
  onStop?: () => ValueOrPromise<void>;
}

/**
 * Bind an already-constructed Drizzle client into the application context.
 *
 * - Binds `client` as a SINGLETON constant under `options.key` (default
 *   {@link DrizzleBindings.CLIENT}).
 * - When `options.onStop` is given, registers a lifecycle observer so
 *   `app.stop()` drains the pool — exactly once, idempotently.
 *
 * The package is generic over the Drizzle dialect; the app builds the client
 * (`drizzle(pool, {schema})`) and passes it in:
 *
 * ```ts
 * const pool = new Pool({connectionString: process.env.DATABASE_URL});
 * registerDrizzle(app, drizzle(pool, {schema}), {onStop: () => pool.end()});
 * ```
 *
 * @param app - The application (any `Context` with `Application`'s lifecycle
 * registration; lifecycle observers fire on `app.stop()`).
 * @param client - The Drizzle database instance.
 * @param options - Optional binding key and shutdown callback.
 * @returns The binding created for the client.
 */
export function registerDrizzle<T>(
  app: Application,
  client: T,
  options: RegisterDrizzleOptions = {},
): Binding<T> {
  const key = (options.key ?? DrizzleBindings.CLIENT) as BindingAddress<T>;
  const binding = app.bind(key).to(client).inScope(BindingScope.SINGLETON);

  const onStop = options.onStop;
  if (onStop) {
    let stopped = false;
    app.onStop(async function drizzleOnStop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await onStop();
    });
  }
  return binding;
}
