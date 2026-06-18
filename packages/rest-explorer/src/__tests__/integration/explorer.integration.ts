// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication, type RestServer} from '@agentback/rest';
import {installExplorer} from '../../index.js';

@api({basePath: '/g'})
class GreetingController {
  @get('/hello', {response: z.object({greeting: z.string()})})
  hello() {
    return {greeting: 'hi'};
  }
}

describe('rest-explorer', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(GreetingController);
    await installExplorer(app, {title: 'Test API'});
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterEach(async () => app.stop());

  it('serves the Swagger UI HTML at /explorer and /explorer/', async () => {
    for (const path of ['/explorer', '/explorer/']) {
      const r = await client.get(path).expect(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.text).toMatch(/<title>Test API<\/title>/);
      expect(r.text).toMatch(/swagger-ui-bundle\.js/);
    }
  });

  it('points Swagger UI at /openapi.json by default', async () => {
    const r = await client.get('/explorer/').expect(200);
    expect(r.text).toMatch(/url:\s*"\/openapi\.json"/);
  });

  it('serves swagger-ui-dist static assets under /explorer', async () => {
    const css = await client.get('/explorer/swagger-ui.css').expect(200);
    expect(css.headers['content-type']).toMatch(/text\/css/);
    const js = await client.get('/explorer/swagger-ui-bundle.js').expect(200);
    expect(js.headers['content-type']).toMatch(
      /application\/javascript|text\/javascript/,
    );
  });

  it('OpenAPI spec is reachable at /openapi.json', async () => {
    const r = await client.get('/openapi.json').expect(200);
    expect(r.body.openapi).toBe('3.1.1');
  });
});

// Proves the neutral fetch path (addFetchHandler / addFetchPrefix) serves the
// same UI and assets that the Express path does — without an HTTP server.
describe('rest-explorer — neutral fetch path', () => {
  let app: RestApplication;
  let server: RestServer;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(GreetingController);
    await installExplorer(app, {title: 'Fetch Test'});
    await app.start();
    server = await app.restServer;
  });

  afterAll(async () => app.stop());

  it('serves the HTML shell at /explorer/ via fetchHandler()', async () => {
    const res = await server
      .fetchHandler()
      .fetch(new Request('http://x/explorer/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const text = await res.text();
    expect(text).toMatch(/<title>Fetch Test<\/title>/);
  });

  it('redirects /explorer → /explorer/ via fetchHandler()', async () => {
    const res = await server
      .fetchHandler()
      .fetch(new Request('http://x/explorer'));
    expect(res.status).toBe(301);
  });

  it('serves a swagger-ui asset via fetchHandler() prefix handler', async () => {
    const res = await server
      .fetchHandler()
      .fetch(new Request('http://x/explorer/swagger-ui.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);
  });
});
