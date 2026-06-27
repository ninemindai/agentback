// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Context, Binding} from '@agentback/context';
import {BindingKey} from '@agentback/context';
import type {z} from 'zod';
import {
  getConfigDir,
  loadConfigFile,
  loadRawConfigFile,
} from './config-loader.js';
import {CONFIG_BINDING_TAG} from './keys.js';

/**
 * DI-friendly wrapper around the loader functions. Behaves identically to
 * calling them directly; the value is binding the *result* into a `Context`
 * so other components can `@inject('config.<name>')`.
 */
export class Configuration {
  constructor(private readonly ctx: Context) {}

  /** Resolved config directory (cached at construction call sites). */
  get dir(): string {
    return getConfigDir();
  }

  /**
   * Validate `filename` against `schema` and bind the result to
   * `config.<name>` (or the supplied key). Returns the binding so callers
   * can tag or scope further.
   */
  bind<T>(
    filename: string,
    schema: z.ZodType<T>,
    key?: string | BindingKey<T>,
  ): Binding<T> {
    const data = loadConfigFile(filename, schema);
    const bindingKey =
      key ?? `config.${filename.replace(/\.(jsonc?|ya?ml)$/, '')}`;
    return this.ctx
      .bind<T>(bindingKey as string)
      .to(data)
      .tag(CONFIG_BINDING_TAG);
  }

  /** Load + validate. Does not bind. */
  load<T>(filename: string, schema: z.ZodType<T>): T {
    return loadConfigFile(filename, schema);
  }

  /** Load + overlay + env resolution, but no schema validation. */
  loadRaw(filename: string): unknown | undefined {
    return loadRawConfigFile(filename);
  }
}
