// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp} from '../../index.js';

// `rateLimit` was Express-only. `installMcpHttp` picks the host from
// `rest.listener`, so on the fetch/edge host a caller configured throttling and
// silently got none — the first symptom being a bill rather than an error.
// (It threw at mount in the interim, which made the gap safe but left edge
// deployments with no throttling at all.)
//
// These run over a real socket on BOTH hosts and BOTH protocols, because the
// four combinations reach the limiter by different routes: the Express mount
// through a middleware chain, the fetch mount inline, and `protocol: 'both'`
// through the SDK's stateless handler rather than a session transport.

let invocations = 0;

@mcpServer()
class DemoTools {
  @tool('echo', {input: z.object({text: z.string()})})
  echo(input: {text: string}) {
    invocations++;
    return {echoed: input.text};
  }

  @tool('cheap', {input: z.object({text: z.string()})})
  cheap(input: {text: string}) {
    return {echoed: input.text};
  }
}

const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

describe.each([
  ['express', 'legacy'],
  ['native', 'legacy'],
  ['express', 'both'],
  ['native', 'both'],
] as const)(
  'per-tool rate limiting (%s host, protocol: %s)',
  (listener, protocol) => {
    let app: RestApplication;
    let url: string;
    let headers: Record<string, string>;

    async function start(
      points = 2,
      perTool?: Record<string, {points: number}>,
    ) {
      invocations = 0;
      app = new RestApplication({rest: {listener}});
      app
        .configure('servers.RestServer')
        .to({port: 0, host: '127.0.0.1', listener});
      app.component(MCPComponent);
      app.configure('servers.MCPServer').to({
        name: 'rl',
        version: '0.0.0',
        transports: {stdio: false},
      });
      app.service(DemoTools);
      await app.get<MCPServer>('servers.MCPServer');
      await installMcpHttp(app, {
        protocol,
        rateLimit: {
          points,
          durationSecs: 60,
          // Fixed key: the fetch host has no client IP, so without this the two
          // hosts would bucket differently and the test would prove less.
          keyGenerator: () => 'test-caller',
          ...(perTool ? {perTool} : {}),
        },
      });
      await app.start();
      url = (await app.get<RestServer>('servers.RestServer')).url + '/mcp';
      headers = {...JSON_HEADERS};

      // The session path needs a real handshake before it will accept calls.
      if (protocol === 'legacy') {
        const init = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: {name: 'c', version: '0'},
            },
          }),
        });
        headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
        await init.body?.cancel();
        const ready = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
          }),
        });
        await ready.body?.cancel();
      }
    }

    const callOnce = (name = 'echo', id = 1) =>
      post({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {name, arguments: {text: 'x'}},
      });

    async function post(body: unknown) {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const text = await res.text();
      return {
        status: res.status,
        text,
        retryAfter: res.headers.get('retry-after'),
      };
    }

    afterEach(async () => app?.stop());

    it('allows up to the limit, then 429s with Retry-After', async () => {
      await start(2);
      expect((await callOnce('echo', 1)).status).toBe(200);
      expect((await callOnce('echo', 2)).status).toBe(200);

      const limited = await callOnce('echo', 3);
      expect(limited.status).toBe(429);
      expect(limited.retryAfter).toBeTruthy();
      const body = JSON.parse(limited.text);
      expect(body.error.code).toBe(-32029);
      expect(body.error.message).toContain('echo');
      expect(body.id).toBe(3);
    });

    it('gives each tool its own bucket', async () => {
      await start(1);
      expect((await callOnce('echo', 1)).status).toBe(200);
      expect((await callOnce('cheap', 2)).status).toBe(200); // separate bucket
      expect((await callOnce('echo', 3)).status).toBe(429);
    });

    it('does not limit non-tools/call traffic', async () => {
      await start(1);
      // Exhaust the tool bucket, then confirm discovery still works — a limiter
      // that throttled tools/list would break clients that re-enumerate.
      expect((await callOnce('echo', 1)).status).toBe(200);
      expect((await callOnce('echo', 2)).status).toBe(429);
      const list = await post({jsonrpc: '2.0', id: 3, method: 'tools/list'});
      expect(list.status).toBe(200);
    });

    it('counts a batched array instead of letting it through', async () => {
      // The bypass: an array body made the old limiter read `body.method` as
      // undefined and wave the whole thing through. Verified against the shipping
      // Express mount — a caller already answered 429 got a 200 and five more
      // tool invocations by wrapping them in an array.
      await start(2);
      expect((await callOnce('echo', 1)).status).toBe(200);
      expect((await callOnce('echo', 2)).status).toBe(200);
      expect((await callOnce('echo', 3)).status).toBe(429);

      const before = invocations;
      const batch = await post(
        Array.from({length: 5}, (_, i) => ({
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'tools/call',
          params: {name: 'echo', arguments: {text: 'b'}},
        })),
      );
      expect(batch.status).toBe(429);
      expect(invocations).toBe(before); // nothing ran
    });

    it('honours per-tool overrides', async () => {
      await start(5, {echo: {points: 1}});
      expect((await callOnce('echo', 1)).status).toBe(200);
      expect((await callOnce('echo', 2)).status).toBe(429); // override = 1
      expect((await callOnce('cheap', 3)).status).toBe(200); // default = 5
    });
  },
);
