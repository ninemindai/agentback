// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {RestApplication} from '@agentback/rest';
import {runInstallConformance} from '@agentback/testing';
import {installMcpConnect} from '../../index.js';

// Express-only: mountMcpConnect registers no fetch-host handlers.
runInstallConformance('installMcpConnect', {
  makeApp: () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    return app;
  },
  install: app => installMcpConnect(app),
  served: ['/mcp-connect/api/targets'],
  untouched: ['/openapi.json'],
  hosts: ['express'],
});
