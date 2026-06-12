// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/context';
import type {Configuration} from './configuration.js';

export namespace ConfigBindings {
  /** Resolved absolute path of the config directory. */
  export const CONFIG_DIR = BindingKey.create<string>('config.dir');
  /** Singleton Configuration service. */
  export const CONFIGURATION =
    BindingKey.create<Configuration>('config.service');
}

/** Tag applied to bindings created via `Configuration.bind()`. */
export const CONFIG_BINDING_TAG = 'config';
