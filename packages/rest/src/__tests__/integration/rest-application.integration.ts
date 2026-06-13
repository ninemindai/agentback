// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {RestApplication} from '../../rest.application.js';

describe('RestApplication constructor config', () => {
  it('forwards `rest` config to the RestServer binding', async () => {
    const app = new RestApplication({
      rest: {basePath: '/api', host: '0.0.0.0'},
    });
    const server = await app.restServer;
    expect(server.config.basePath).toBe('/api');
    expect(server.config.host).toBe('0.0.0.0');
  });

  it('lets a later app.configure() override the constructor config', async () => {
    const app = new RestApplication({rest: {basePath: '/api'}});
    app.configure('servers.RestServer').to({basePath: '/v2'});
    const server = await app.restServer;
    expect(server.config.basePath).toBe('/v2');
  });

  it('leaves defaults intact when no `rest` config is passed', async () => {
    const app = new RestApplication({});
    const server = await app.restServer;
    expect(server.config.basePath).toBe('');
    expect(server.config.host).toBe('127.0.0.1');
  });
});
