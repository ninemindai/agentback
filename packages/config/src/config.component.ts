// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {inject} from '@agentback/context';
import {Application, Component, CoreBindings} from '@agentback/core';
import {Configuration} from './configuration.js';
import {ConfigBindings} from './keys.js';
import {getConfigDir} from './config-loader.js';

/**
 * Registers a singleton `Configuration` service and the resolved config dir.
 *
 * ```ts
 * const app = new RestApplication();
 * app.component(ConfigComponent);
 *
 * const cfg = await app.get(ConfigBindings.CONFIGURATION);
 * cfg.bind('redis.jsonc', RedisConfigSchema);
 * // -> app.get('config.redis') yields the validated value
 * ```
 */
export class ConfigComponent implements Component {
  constructor(@inject(CoreBindings.APPLICATION_INSTANCE) app: Application) {
    app.bind(ConfigBindings.CONFIG_DIR).to(getConfigDir());
    app.bind(ConfigBindings.CONFIGURATION).to(new Configuration(app));
  }
}
