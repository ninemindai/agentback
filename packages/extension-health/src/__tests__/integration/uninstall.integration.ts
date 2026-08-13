// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {RestApplication} from '@agentback/rest';
import {runInstallConformance} from '@agentback/testing';
import {installHealth} from '../../index.js';

// Express-only: mountHealth registers no fetch-host handlers.
runInstallConformance('installHealth', {
  makeApp: () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    return app;
  },
  install: app => installHealth(app),
  served: ['/health', '/ready'],
  untouched: ['/openapi.json'],
  hosts: ['express'],
});
