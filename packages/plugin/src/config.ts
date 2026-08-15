// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import {z} from 'zod';
import type {PluginRegistry} from './registry.js';

export const PluginsConfig = z
  .object({
    scan: z.boolean().default(true),
    dirs: z.array(z.string()).default([]),
    enable: z.array(z.string()).optional(),
    disable: z.array(z.string()).default([]),
    order: z.array(z.string()).default([]),
    allowOverride: z.array(z.string()).default([]),
    strict: z.boolean().default(true),
  })
  .prefault({});

export type PluginsConfigInput = z.input<typeof PluginsConfig>;
export type PluginsConfigResolved = z.output<typeof PluginsConfig>;

export namespace PluginBindings {
  export const CONFIG = BindingKey.create<PluginsConfigInput>('plugins.config');
  /** Live mounted-plugin state. Bound on first use by the loader. */
  export const REGISTRY = BindingKey.create<PluginRegistry>('plugins.registry');
}
