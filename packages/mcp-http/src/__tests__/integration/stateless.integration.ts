// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {OAuthError, OAuthErrorCode} from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {RestApplication, type RestServer} from '@agentback/rest';
import {MCPComponent, MCPServer, mcpServer, tool} from '@agentback/mcp';
import {installMcpHttp, mountMcpHttpFetch} from '../../index.js';

// `protocol: 'both'` serves the 2026-07-28 revision — and 2025-era traffic
// from the same endpoint — with no session at all. Unlike modern-era
// .integration.ts (which drives the handler in-process), this goes over a real
// socket through the fetch/edge host, so it covers the actual mount wiring:
// auth pass-through, both eras on one URL, and the absence of session ops.

const EchoIn = z.object({text: z.string().min(1)});

@mcpServer()
class SlowTools {
  /** Keeps the exchange open long enough to abort or fail mid-flight. */
  @tool('slow', {input: z.object({ms: z.number()})})
  async slow(input: {ms: number}) {
    await new Promise(r => setTimeout(r, input.ms));
    return {done: true};
  }

  @tool('boom')
  async boom() {
    await new Promise(r => setTimeout(r, 50));
    throw new Error('tool exploded mid-flight');
  }
}

@mcpServer()
class DemoTools {
  @tool('echo', {input: EchoIn})
  echo(input: z.infer<typeof EchoIn>) {
    return {echoed: input.text};
  }

  @tool('secret', {scope: 'admin'})
  secret() {
    return {ok: true};
  }
}

const DeployIn = z.object({env: z.enum(['prod', 'staging'])});

@mcpServer()
class DangerTools {
  @tool('deploy', {input: DeployIn, confirm: true})
  deploy(input: z.infer<typeof DeployIn>) {
    return {deployed: input.env};
  }
}

const verifier = {
  async verifyAccessToken(token: string) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    if (token === 'admin')
      return {token, clientId: 'cli', scopes: ['admin'], expiresAt};
    if (token === 'plain')
      return {token, clientId: 'cli', scopes: [], expiresAt};
    throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token');
  },
};

describe("mcp-http protocol: 'both' (fetch host)", () => {
  let app: RestApplication;
  let mcpUrl: URL;

  async function start(opts: {auth?: boolean} = {}) {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'stateless',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DemoTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {
      protocol: 'both',
      ...(opts.auth
        ? {
            auth: {
              verifier,
              resource: 'https://example.test/mcp',
              authorizationServers: ['https://as.example.test'],
            },
          }
        : {}),
    });
    await app.start();
    mcpUrl = new URL(
      (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
    );
  }

  async function connect(opts: {token?: string; modern?: boolean} = {}) {
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      opts.modern === false
        ? {}
        : {versionNegotiation: {mode: 'auto' as const}},
    );
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl, {
        ...(opts.token
          ? {
              requestInit: {
                headers: {authorization: `Bearer ${opts.token}`},
              },
            }
          : {}),
      }),
    );
    return client;
  }

  afterEach(async () => app?.stop());

  it('serves the modern era over a real socket', async () => {
    await start();
    const client = await connect();
    expect(client.getProtocolEra()).toBe('modern');
    const {tools} = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['echo', 'secret']);
    const res = await client.callTool({
      name: 'echo',
      arguments: {text: 'stateless'},
    });
    expect(JSON.stringify(res.content)).toContain('stateless');
    await client.close();
  });

  it('serves a 2025-era client from the same endpoint', async () => {
    await start();
    const client = await connect({modern: false});
    expect(client.getProtocolEra()).toBe('legacy');
    expect((await client.listTools()).tools.length).toBe(2);
    await client.close();
  });

  it('mints no session id — there is no session', async () => {
    await start();
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    expect(res.headers.get('mcp-session-id')).toBeNull();
    await res.body?.cancel();
  });

  it('gates tool visibility per request from the bearer principal', async () => {
    await start({auth: true});
    const admin = await connect({token: 'admin'});
    expect((await admin.listTools()).tools.map(t => t.name).sort()).toEqual([
      'echo',
      'secret',
    ]);
    await admin.close();

    const plain = await connect({token: 'plain'});
    expect((await plain.listTools()).tools.map(t => t.name)).toEqual(['echo']);
    await plain.close();
  });

  it('still rejects an invalid bearer token with 401', async () => {
    await start({auth: true});
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer nope',
      },
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
    });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });
});

// S4b: per-request DI contexts, on both hosts. Disposal rides the SDK's own
// lifetime signal — it closes the per-request server when the exchange
// completes, AFTER any streamed progress and before the body finishes draining,
// so `onclose` is the correct release point. Closing when `fetch()` resolves
// would be far too early: fetch() returns before the tool does any work.
describe("protocol: 'both' per-request DI contexts", () => {
  for (const listener of ['express', 'native'] as const) {
    describe(`${listener} host`, () => {
      let app: RestApplication;
      let mcpUrl: URL;
      const opened: Array<{closed: boolean}> = [];

      beforeEach(async () => {
        opened.length = 0;
        app = new RestApplication(
          listener === 'native' ? {rest: {listener: 'native'}} : {},
        );
        app.configure('servers.RestServer').to({
          port: 0,
          host: '127.0.0.1',
          ...(listener === 'native' ? {listener: 'native'} : {}),
        });
        app.component(MCPComponent);
        app.configure('servers.MCPServer').to({
          name: 'per-request',
          version: '0.0.0',
          transports: {stdio: false},
        });
        app.service(DemoTools);
        await app.get<MCPServer>('servers.MCPServer');
        await installMcpHttp(app, {
          protocol: 'both',
          perSession(ctx) {
            // Track disposal without reaching into Context internals: close()
            // is idempotent and observable through the subscription it drops.
            const record = {closed: false};
            opened.push(record);
            const original = ctx.close.bind(ctx);
            ctx.close = () => {
              record.closed = true;
              original();
            };
          },
        });
        await app.start();
        mcpUrl = new URL(
          (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
        );
      });

      afterEach(async () => app?.stop());

      it('builds one context per request and disposes every one', async () => {
        const client = new Client(
          {name: 'c', version: '0.0.0'},
          {versionNegotiation: {mode: 'auto' as const}},
        );
        await client.connect(new StreamableHTTPClientTransport(mcpUrl));
        await client.listTools();
        await client.callTool({name: 'echo', arguments: {text: 'x'}});
        await client.close();

        // One per HTTP request (discovery probe + list + call), all released.
        expect(opened.length).toBeGreaterThanOrEqual(2);
        expect(opened.every(o => o.closed)).toBe(true);
      });

      it('leaks nothing across many sequential requests', async () => {
        const client = new Client(
          {name: 'c', version: '0.0.0'},
          {versionNegotiation: {mode: 'auto' as const}},
        );
        await client.connect(new StreamableHTTPClientTransport(mcpUrl));
        for (let i = 0; i < 5; i++) {
          await client.callTool({name: 'echo', arguments: {text: `n${i}`}});
        }
        await client.close();

        expect(opened.length).toBeGreaterThanOrEqual(5);
        expect(opened.filter(o => !o.closed)).toEqual([]);
      });
    });
  }
});

// The `confirm:` flow is implemented entirely in userland — a tool error
// carrying a single-use token, and a `confirmationToken` input property — so it
// has no era-specific machinery. This test exists to establish that, because
// the migration plan assumed `confirm:` would have to move to the protocol's
// native multi-round-trip requests (MRTR) before the default could flip. If it
// already works unchanged on the modern era, that migration is an ENHANCEMENT
// rather than a prerequisite, and S7 is not blocked on it.
describe('confirm: tools on the modern era', () => {
  let app: RestApplication;
  let mcpUrl: URL;

  beforeEach(async () => {
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'confirm',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(DangerTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {protocol: 'both'});
    await app.start();
    mcpUrl = new URL(
      (await app.get<RestServer>('servers.RestServer')).url + '/mcp',
    );
  });

  afterEach(async () => app?.stop());

  const errorOf = (r: {content: unknown}) =>
    JSON.parse((r.content as {type: string; text: string}[])[0].text).error;

  it('round-trips confirmation across separate stateless requests', async () => {
    // Each call is its own request with its own server instance — the token
    // must survive that, which it does because the confirmation store lives on
    // the application, not the per-request context.
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      {versionNegotiation: {mode: 'auto' as const}},
    );
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    expect(client.getProtocolEra()).toBe('modern');

    const first = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod'},
    });
    expect(first.isError).toBe(true);
    const err = errorOf(first);
    expect(err.code).toBe('confirmation_required');
    expect(err.confirmationToken).toBeTruthy();

    const confirmed = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod', confirmationToken: err.confirmationToken},
    });
    expect(confirmed.isError).toBeFalsy();
    expect(
      JSON.parse((confirmed.content as {type: string; text: string}[])[0].text),
    ).toEqual({deployed: 'prod'});

    await client.close();
  });

  /** A modern client that CAN prompt, answering every elicitation the same way. */
  async function elicitingClient(action: 'accept' | 'decline' | 'cancel') {
    const prompts: string[] = [];
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      {
        versionNegotiation: {mode: 'auto' as const},
        capabilities: {elicitation: {}},
      },
    );
    client.setRequestHandler(
      'elicitation/create',
      async (req: {params: {message: string}}) => {
        prompts.push(req.params.message);
        return {
          action,
          ...(action === 'accept' ? {content: {confirm: true}} : {}),
        };
      },
    );
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    return {client, prompts};
  }

  it('asks a capable host natively, in ONE call from the caller', async () => {
    // The point of S6. The caller makes one `callTool`; the host renders a real
    // prompt and the SDK completes the round trip. No token is replayed by the
    // model, which is what the token dance always asked it to do.
    const {client, prompts} = await elicitingClient('accept');
    const res = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod'},
    });
    expect(prompts).toEqual(['Confirm running deploy.']);
    expect(res.isError).toBeFalsy();
    expect(
      JSON.parse((res.content as {type: string; text: string}[])[0].text),
    ).toEqual({deployed: 'prod'});
    await client.close();
  });

  for (const action of ['decline', 'cancel'] as const) {
    it(`does not run the tool when the human says no (${action})`, async () => {
      // A prompt whose answer is ignored is worse than no prompt.
      const {client} = await elicitingClient(action);
      const res = await client.callTool({
        name: 'deploy',
        arguments: {env: 'prod'},
      });
      expect(res.isError).toBe(true);
      expect(errorOf(res).code).toBe('confirmation_invalid');
      expect(errorOf(res).message).toMatch(
        action === 'cancel' ? /cancelled/ : /declined/,
      );
      await client.close();
    });
  }

  it('falls back to the token dance for a modern client that cannot prompt', async () => {
    // Being on the new era does NOT imply being able to ask a human anything.
    // The SDK rejects an elicitation a client never declared, so gating on era
    // alone turned every such confirmation into a protocol error — which is how
    // this was caught. `capabilities` is left empty here deliberately.
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      {versionNegotiation: {mode: 'auto' as const}},
    );
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));
    expect(client.getProtocolEra()).toBe('modern');

    const first = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod'},
    });
    expect(errorOf(first).code).toBe('confirmation_required');
    expect(errorOf(first).confirmationToken).toBeTruthy();
    await client.close();
  });

  it('still refuses a valid token against a tampered payload', async () => {
    const client = new Client(
      {name: 'c', version: '0.0.0'},
      {versionNegotiation: {mode: 'auto' as const}},
    );
    await client.connect(new StreamableHTTPClientTransport(mcpUrl));

    const first = await client.callTool({
      name: 'deploy',
      arguments: {env: 'prod'},
    });
    const tampered = await client.callTool({
      name: 'deploy',
      arguments: {
        env: 'staging',
        confirmationToken: errorOf(first).confirmationToken,
      },
    });
    expect(errorOf(tampered).code).toBe('confirmation_invalid');
    await client.close();
  });
});

// DNS-rebinding protection under `protocol: 'both'`. The session path gets
// this from the transport's own options; createMcpHandler has none, so the
// stateless path mounts the SDK's standalone validators. Without them a user
// who configured an allowlist and switched to stateless silently lost it.
//
// The Origin cases also pin the normalization: `allowedOrigins` is documented
// as Origin HEADER VALUES (`https://app.example.com`), but the SDK validators
// compare HOSTNAMES. Forwarding the configured array unnormalized would reject
// every request — fail-closed, but broken.
describe("protocol: 'both' DNS-rebinding protection", () => {
  for (const listener of ['express', 'native'] as const) {
    describe(`${listener} host`, () => {
      let app: RestApplication;
      let base: string;

      async function start(
        opts: {
          allowedHosts?: string[];
          allowedOrigins?: string[];
          enableDnsRebindingProtection?: boolean;
        },
        cors?: boolean | {origin?: string | string[]},
      ) {
        app = new RestApplication(
          listener === 'native' ? {rest: {listener: 'native'}} : {},
        );
        app.configure('servers.RestServer').to({
          port: 0,
          host: '127.0.0.1',
          ...(cors !== undefined ? {cors} : {}),
          ...(listener === 'native' ? {listener: 'native'} : {}),
        });
        app.component(MCPComponent);
        app.configure('servers.MCPServer').to({
          name: 'rebind',
          version: '0.0.0',
          transports: {stdio: false},
        });
        app.service(DemoTools);
        await app.get<MCPServer>('servers.MCPServer');
        await installMcpHttp(app, {protocol: 'both', ...opts});
        await app.start();
        base = (await app.get<RestServer>('servers.RestServer')).url;
      }

      const post = (headers: Record<string, string> = {}) =>
        fetch(base + '/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list'}),
        });

      afterEach(async () => app?.stop());

      it('rejects a Host outside the allowlist', async () => {
        // The server is reached at 127.0.0.1, so the real Host header can never
        // match this allowlist — no header spoofing needed to exercise it.
        await start({allowedHosts: ['mcp.example.com']});
        const res = await post();
        expect(res.status).toBeGreaterThanOrEqual(400);
        await res.body?.cancel();
      });

      it('allows a Host that is on the allowlist', async () => {
        const port = new URL(base).port;
        await start({allowedHosts: [`127.0.0.1:${port}`, '127.0.0.1']});
        const res = await post();
        expect(res.status).toBe(200);
        await res.body?.cancel();
      });

      it('rejects a disallowed Origin', async () => {
        await start({allowedOrigins: ['https://app.example.com']});
        const res = await post({origin: 'https://evil.test'});
        expect(res.status).toBeGreaterThanOrEqual(400);
        await res.body?.cancel();
      });

      it('accepts an allowlisted Origin configured as a full origin', async () => {
        // The normalization case: config carries a full origin, the SDK
        // validator compares hostnames. Unnormalized, this would 4xx.
        await start({allowedOrigins: ['https://app.example.com']});
        const res = await post({origin: 'https://app.example.com'});
        expect(res.status).toBe(200);
        await res.body?.cancel();
      });

      // The Streamable HTTP binding has required Origin validation on every
      // revision since 2025-03-26; configuring nothing used to mean no check at
      // all, which is the exact combination DNS-rebinding defense exists for.
      it('rejects a foreign Origin with NOTHING configured', async () => {
        await start({});
        const res = await post({origin: 'https://evil.test'});
        expect(res.status).toBe(403);
        await res.body?.cancel();
      });

      it('still serves a request that sends no Origin at all', async () => {
        // The non-breakage guarantee: only browsers send `Origin`, so every MCP
        // client, curl and stdio bridge is untouched by the new default. If
        // this ever fails, the default has become a breaking change.
        await start({});
        const res = await post();
        expect(res.status).toBe(200);
        await res.body?.cancel();
      });

      it('admits an Origin that `rest.cors` already declares', async () => {
        // One source of truth: the app said this origin may call it, so the
        // rebinding allowlist reuses that rather than asking a second time.
        await start({}, {origin: 'https://app.example.com'});
        const res = await post({origin: 'https://app.example.com'});
        expect(res.status).toBe(200);
        await res.body?.cancel();
      });

      it('leaves validation off when cors admits any origin', async () => {
        // Nothing to enumerate, so nothing is derived (a warning is logged).
        // Locking down to localhost here would break the browser client this
        // very config admits.
        await start({}, true);
        const res = await post({origin: 'https://evil.test'});
        expect(res.status).toBe(200);
        await res.body?.cancel();
      });

      it('validates anyway when protection is requested by name', async () => {
        // An explicit `enableDnsRebindingProtection: true` must never be a
        // no-op. With `cors: true` nothing is derivable, so it falls back to
        // localhost rather than silently enforcing nothing.
        await start({enableDnsRebindingProtection: true}, true);
        const res = await post({origin: 'https://evil.test'});
        expect(res.status).toBe(403);
        await res.body?.cancel();
      });

      // Only the fetch mount takes a RestServer, so only it can self-serve.
      it.skipIf(listener !== 'native')(
        'derives from rest.cors when mounted directly, no installMcpHttp',
        async () => {
          // `mountMcpHttpFetch` is the documented low-level path for Bun,
          // Workers and custom hosts. It is handed the RestServer, so it must
          // reach the same allowlist as `installMcpHttp` rather than silently
          // falling back to localhost-only and 403ing a configured origin.
          app = new RestApplication({rest: {listener: 'native'}});
          app.configure('servers.RestServer').to({
            port: 0,
            host: '127.0.0.1',
            listener: 'native',
            cors: {origin: 'https://direct.example.com'},
          });
          app.component(MCPComponent);
          app.configure('servers.MCPServer').to({
            name: 'direct',
            version: '0.0.0',
            transports: {stdio: false},
          });
          app.service(DemoTools);
          const mcp = await app.get<MCPServer>('servers.MCPServer');
          const restServer = await app.get<RestServer>('servers.RestServer');
          mountMcpHttpFetch(mcp, restServer, {protocol: 'both'});
          await app.start();
          base = restServer.url;

          const allowed = await post({origin: 'https://direct.example.com'});
          expect(allowed.status).toBe(200);
          await allowed.body?.cancel();

          const denied = await post({origin: 'https://evil.test'});
          expect(denied.status).toBe(403);
          await denied.body?.cancel();
        },
      );

      // Characterization, not endorsement: `validateOriginHeader` compares
      // HOSTNAMES, so a CORS grant naming exactly `https://app.example.com`
      // also admits `http://` and any port on that host. Deriving from CORS
      // therefore widens a precise grant. Pinned so the widening is known
      // behaviour rather than a surprise, and so a future SDK that tightens
      // the comparison shows up here as a failure to react to.
      it('widens a CORS origin to its whole hostname', async () => {
        await start({}, {origin: 'https://app.example.com'});
        const downgraded = await post({origin: 'http://app.example.com'});
        expect(downgraded.status).toBe(200); // scheme ignored
        await downgraded.body?.cancel();

        const otherPort = await post({origin: 'https://app.example.com:8443'});
        expect(otherPort.status).toBe(200); // port ignored
        await otherPort.body?.cancel();

        const other = await post({origin: 'https://evil.test'});
        expect(other.status).toBe(403); // but a different host is still out
        await other.body?.cancel();
      });

      it('rejects the opaque `null` Origin browsers send', async () => {
        // Sandboxed iframes and some redirects produce `Origin: null`. It is
        // not a hostname and must not be treated as "no Origin" (which passes).
        await start({});
        const res = await post({origin: 'null'});
        expect(res.status).toBe(403);
        await res.body?.cancel();
      });

      it('says how to fix it in the 403 body', async () => {
        // A derived default that 403s a browser must say why, in the channel
        // the person debugging is actually looking at. The log is not that
        // channel: framework loggers are `debug`-namespaced and emit nothing
        // unless DEBUG is set, whereas a browser developer already has the
        // failed request open in devtools.
        await start({});
        const res = await post({origin: 'https://evil.test'});
        expect(res.status).toBe(403);
        const body = (await res.json()) as {error: {message: string}};
        expect(body.error.message).toContain('evil.test');
        expect(body.error.message).toContain('allowedOrigins');
        expect(body.error.message).toContain('rest.cors');
      });
    });
  }
});

// The disposal proof for per-request DI contexts originally covered only the
// happy streaming path: fetch resolves, progress ticks, onclose, body drains.
// These cover the paths that actually leak in production — a client that hangs
// up, a tool that throws mid-flight, and a body nobody reads. If `onclose` does
// not fire on those, a long-running server accumulates one Context per
// abandoned request and never reaches `handler.close()` to catch up.
describe("protocol: 'both' context disposal on failure paths", () => {
  let app: RestApplication;
  let base: string;
  const opened: Array<{closed: boolean}> = [];

  beforeEach(async () => {
    opened.length = 0;
    app = new RestApplication({rest: {listener: 'native'}});
    app.configure('servers.RestServer').to({
      port: 0,
      host: '127.0.0.1',
      listener: 'native',
    });
    app.component(MCPComponent);
    app.configure('servers.MCPServer').to({
      name: 'disposal',
      version: '0.0.0',
      transports: {stdio: false},
    });
    app.service(SlowTools);
    await app.get<MCPServer>('servers.MCPServer');
    await installMcpHttp(app, {
      protocol: 'both',
      perSession(ctx) {
        const record = {closed: false};
        opened.push(record);
        const original = ctx.close.bind(ctx);
        ctx.close = () => {
          record.closed = true;
          original();
        };
      },
    });
    await app.start();
    base = (await app.get<RestServer>('servers.RestServer')).url;
  });

  afterEach(async () => app?.stop());

  /** Wait until every opened context is disposed, or give up. */
  async function settled(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opened.length > 0 && opened.every(o => o.closed)) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  }

  const call = (name: string, args: unknown, signal?: AbortSignal) =>
    fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {name, arguments: args},
      }),
      ...(signal ? {signal} : {}),
    });

  it('disposes the context when the client aborts mid-flight', async () => {
    const ac = new AbortController();
    const inflight = call('slow', {ms: 3000}, ac.signal).catch(() => undefined);
    await new Promise(r => setTimeout(r, 150)); // let the exchange open
    ac.abort();
    await inflight;

    expect(await settled()).toBe(true);
  });

  it('disposes the context when the tool throws mid-flight', async () => {
    const res = await call('boom', {});
    await res.body?.cancel();

    expect(await settled()).toBe(true);
  });

  it('disposes the context when the body is never read', async () => {
    // No .text(), no .cancel() — the shape a careless caller produces.
    await call('slow', {ms: 10});

    expect(await settled()).toBe(true);
  });
});
