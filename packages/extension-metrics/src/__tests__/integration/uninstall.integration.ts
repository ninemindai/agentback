// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {RestApplication} from '@agentback/rest';
import {runInstallConformance} from '@agentback/testing';
import {installMetrics, promClient} from '../../index.js';

// Express-only: mountMetrics registers no fetch-host handlers. A fresh
// Registry per boot keeps prom-client's process-global default registry out
// of the test (double-registration would throw across boots).
runInstallConformance('installMetrics', {
  makeApp: () => {
    const app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    return app;
  },
  install: app => installMetrics(app, {registry: new promClient.Registry()}),
  served: ['/metrics'],
  untouched: ['/openapi.json'],
  hosts: ['express'],
});
