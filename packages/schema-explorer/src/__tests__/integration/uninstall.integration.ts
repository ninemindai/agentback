// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {RestApplication} from '@agentback/rest';
import {runInstallConformance} from '@agentback/testing';
import {installSchemaExplorer} from '../../index.js';

runInstallConformance('installSchemaExplorer', {
  makeApp: () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    return app;
  },
  install: app => installSchemaExplorer(app),
  served: [
    '/schema-explorer',
    '/schema-explorer/',
    '/schema-explorer/api/schemas',
  ],
  untouched: ['/openapi.json'],
});
