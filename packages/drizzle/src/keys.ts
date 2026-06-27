// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';

/**
 * Binding keys for the Drizzle integration.
 *
 * The framework does not depend on a specific Drizzle driver, so the keys are
 * typed `unknown`. Apps keep precise types by declaring an app-level alias and
 * using it at the injection site:
 *
 * ```ts
 * import type {NodePgDatabase} from 'drizzle-orm/node-postgres';
 * import * as schema from '../db/schema.js';
 *
 * export type AppDb = NodePgDatabase<typeof schema>;
 *
 * constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}
 * ```
 */
export namespace DrizzleBindings {
  /**
   * The default binding key for the app's primary Drizzle client
   * (`datasources.drizzle`). Bound by {@link registerDrizzle} when no `key`
   * option is given.
   */
  export const CLIENT = BindingKey.create<unknown>('datasources.drizzle');

  /**
   * Derive a binding key for a named datasource, e.g.
   * `DrizzleBindings.datasource('analytics')` → `datasources.analytics`.
   *
   * Use with the `key` option of {@link registerDrizzle} to wire multiple
   * databases, and at the matching `@inject(...)` site. The type parameter is
   * a convenience for the injection side; it is not enforced at bind time.
   */
  export function datasource<T = unknown>(name: string): BindingKey<T> {
    return BindingKey.create<T>(`datasources.${name}`);
  }
}
