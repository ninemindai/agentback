// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, describe, expect, it} from 'vitest';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {
  InMemoryEventStore,
  installMcpHttp,
  mountMcpHttpFetch,
} from '../../index.js';

// Every session on a mount shares the configured eventStore, and the SDK names
// every session's standalone stream "_GET_stream". A session that resumed its
// standalone stream with Last-Event-ID was replayed the other sessions'
// events too. Raw HTTP, so the test controls exactly when each session's GET
// stream is open (an SDK client would hold it open and the resume would 409).

// Pre-2025-11-25, so the transport writes no priming events and the store
// holds only the list_changed notifications under test.
const PROTOCOL = '2025-06-18';

@mcpServer()
class BaseTools {
  @tool('base')
  base() {
    return {base: true};
  }
}

@mcpServer()
class LateTools {
  @tool('late')
  late() {
    return {late: true};
  }
}

async function rpc(url: URL, body: object, sessionId?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId
        ? {'mcp-session-id': sessionId, 'mcp-protocol-version': PROTOCOL}
        : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Open a 2025 session over raw HTTP; returns its id. */
async function openSession(url: URL): Promise<string> {
  const init = await rpc(url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: {name: 'raw', version: '0.0.0'},
    },
  });
  const sessionId = init.headers.get('mcp-session-id')!;
  await init.body?.cancel();
  const done = await rpc(
    url,
    {jsonrpc: '2.0', method: 'notifications/initialized'},
    sessionId,
  );
  await done.body?.cancel();
  return sessionId;
}

/** Open the standalone GET stream, optionally resuming after an event id. */
function openStream(url: URL, sessionId: string, lastEventId?: string) {
  const abort = new AbortController();
  const response = fetch(url, {
    method: 'GET',
    headers: {
      accept: 'text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': PROTOCOL,
      ...(lastEventId ? {'last-event-id': lastEventId} : {}),
    },
    signal: abort.signal,
  });
  return {response, abort};
}

/** Read SSE event ids for up to `ms`, or until `max` have arrived. */
async function readIds(response: Response, ms: number, max = Infinity) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const ids = () => [...text.matchAll(/^id: (.+)$/gm)].map(m => m[1]);
  const deadline = Date.now() + ms;
  while (ids().length < max) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), left)),
    ]);
    if (!chunk || chunk.done) break;
    text += decoder.decode(chunk.value, {stream: true});
  }
  await reader.cancel().catch(() => {});
  return ids();
}

for (const listener of ['express', 'native'] as const) {
  describe(`session-scoped event replay (${listener} host)`, () => {
    let app: RestApplication | undefined;
    let closeMount: (() => Promise<void>) | undefined;

    afterEach(async () => {
      await closeMount?.();
      closeMount = undefined;
      await app?.stop();
      app = undefined;
    });

    async function boot(store: InMemoryEventStore) {
      app = new RestApplication(
        listener === 'native' ? {rest: {listener: 'native'}} : {},
      );
      app.configure('servers.RestServer').to({
        port: 0,
        host: '127.0.0.1',
        ...(listener === 'native' ? {listener: 'native' as const} : {}),
      });
      app.component(MCPComponent);
      app.configure('servers.MCPServer').to({
        name: 'scoped-replay',
        version: '0.0.0',
        transports: {stdio: false},
      });
      app.service(BaseTools);
      const mcp = await app.get<MCPServer>('servers.MCPServer');
      const server = await app.get<RestServer>('servers.RestServer');
      const options = {protocol: 'legacy' as const, eventStore: store};
      if (listener === 'native') {
        const handle = mountMcpHttpFetch(mcp, server, options);
        closeMount = () => handle.closeAll();
      } else {
        await installMcpHttp(app, options);
      }
      await app.start();
      return new URL(server.url + '/mcp');
    }

    it('replays a resumed session only its own standalone events', async () => {
      const url = await boot(new InMemoryEventStore());
      const a = await openSession(url);
      await openSession(url); // b: never listens, so its events are only stored

      // a listens live and learns the id of the first change...
      const live = openStream(url, a);
      const liveResponse = await live.response;
      const pendingIds = readIds(liveResponse, 5000, 1);
      app!.service(LateTools);
      const [first] = await pendingIds;
      expect(first).toBeDefined();
      live.abort.abort();

      // ...then misses a second one, which is stored for both sessions.
      app!.unbind('services.LateTools');
      await new Promise(resolve => setTimeout(resolve, 200));

      const resumed = await openStream(url, a, first).response;
      expect(resumed.status).toBe(200);
      const replayed = await readIds(resumed, 500);
      // Each change announces tools, prompts and resources. a is owed the two
      // it had not read from the first change and all three from the second;
      // b's six must not appear (unscoped, this replayed eleven).
      expect(replayed).toHaveLength(5);
    });
  });
}
