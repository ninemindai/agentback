// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {BindingScope, ContextTags, CoreTags, injectable} from '@agentback/core';
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

describe('RestApplication PORT/HOST env support', () => {
  const saved = {PORT: process.env.PORT, HOST: process.env.HOST};

  beforeEach(() => {
    delete process.env.PORT;
    delete process.env.HOST;
  });
  afterEach(() => {
    // Restore the original env so no test leaks into another.
    for (const k of ['PORT', 'HOST'] as const) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('binds PORT/HOST from the environment when no rest config is given', async () => {
    process.env.PORT = '4567';
    process.env.HOST = '0.0.0.0';
    const app = new RestApplication();
    const server = await app.restServer;
    expect(server.config.port).toBe(4567);
    expect(server.config.host).toBe('0.0.0.0');
  });

  it('lets explicit constructor config win over the env (no clobber)', async () => {
    process.env.PORT = '4567';
    const app = new RestApplication({rest: {port: 8080}});
    const server = await app.restServer;
    expect(server.config.port).toBe(8080);
  });

  it('honors PORT=0 (ephemeral port)', async () => {
    process.env.PORT = '0';
    const app = new RestApplication();
    const server = await app.restServer;
    expect(server.config.port).toBe(0);
  });

  it('ignores a malformed PORT and falls back to the default', async () => {
    process.env.PORT = 'not-a-number';
    const app = new RestApplication();
    const server = await app.restServer;
    expect(server.config.port).toBe(3000);
  });
});

describe('RestApplication.restController honors class binding metadata', () => {
  it('falls back to the controllers.<name> key and TRANSIENT scope when the class declares nothing', () => {
    class PlainController {}
    const app = new RestApplication();
    const binding = app.restController(PlainController);
    expect(binding.key).toBe('controllers.PlainController');
    expect(binding.scope).toBe(BindingScope.TRANSIENT);
    // RestServer discovers controllers by the core `controller` tag.
    expect(binding.tagNames).toContain(CoreTags.CONTROLLER);
  });

  it('honors a class-declared scope instead of the TRANSIENT default', () => {
    @injectable({scope: BindingScope.SINGLETON})
    class SingletonController {}
    const app = new RestApplication();
    const binding = app.restController(SingletonController);
    expect(binding.scope).toBe(BindingScope.SINGLETON);
    // helper-supplied controller tag still present
    expect(binding.tagNames).toContain(CoreTags.CONTROLLER);
  });

  it('honors a class-declared binding key instead of the controllers.<name> default', () => {
    @injectable({tags: {[ContextTags.KEY]: 'custom.controllers.Widget'}})
    class WidgetController {}
    const app = new RestApplication();
    const binding = app.restController(WidgetController);
    expect(binding.key).toBe('custom.controllers.Widget');
    // still discoverable for REST routing via the core `controller` tag
    expect(binding.tagNames).toContain(CoreTags.CONTROLLER);
  });
});
