// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {RestApplication} from '@agentback/rest';
import {runInstallConformance} from '@agentback/testing';
import {installContextExplorer} from '../../index.js';

runInstallConformance('installContextExplorer', {
  makeApp: () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    return app;
  },
  install: app => installContextExplorer(app),
  served: [
    '/context-explorer',
    '/context-explorer/',
    '/context-explorer/assets/main.js',
    '/context-explorer/api/model',
  ],
  untouched: ['/openapi.json'],
});
