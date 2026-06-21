// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {RestApplication} from '@agentback/rest';
import {MCPComponent, MCPServer} from '@agentback/mcp';
import {installConsole} from '../../index.js';

// SSE must NOT be read with supertest (it would hang waiting for stream end).
// Use fetch + AbortController and read only the first chunk.
async function readFirstChunk(url: string): Promise<string> {
  const ac = new AbortController();
  const res = await fetch(url, {signal: ac.signal});
  const reader = res.body!.getReader();
  const {value} = await reader.read();
  ac.abort();
  return new TextDecoder().decode(value);
}

describe('console /live SSE endpoint', () => {
  let app: RestApplication;
  let base: string;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'live-test',
      version: '1.0.0',
      transports: {stdio: false},
    });
    await app.get<MCPServer>('servers.MCPServer');
    await installConsole(app, {
      title: 'Live Test',
      unsafeAllowUnauthenticated: true,
    });
    await app.start();
    base = (await app.restServer).url;
  });
  afterEach(async () => app.stop());

  it('serves a hello frame with a bootId at /console/live', async () => {
    const chunk = await readFirstChunk(base + '/console/live');
    expect(chunk).toContain('"type":"hello"');
    expect(chunk).toMatch(/"bootId":"[0-9a-f-]{36}"/);
  });
});
