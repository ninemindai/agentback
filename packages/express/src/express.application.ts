// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Application, ApplicationConfig} from '@agentback/core';
import {ExpressServer} from './express.server.js';

/**
 * A LoopBack application with Express server
 */
export class ExpressApplication extends Application {
  /**
   * Embedded Express Server
   */
  readonly expressServer: ExpressServer;

  constructor(readonly config?: ApplicationConfig) {
    super(config);
    const binding = this.server(ExpressServer);
    this.expressServer = this.getSync(binding.key);
  }
}
