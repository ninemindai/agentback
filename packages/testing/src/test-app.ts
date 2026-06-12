// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  createClient,
  type Client,
  type RouteCallOptions,
  type RouteHandle,
  type RouteOutput,
  type RouteSchemas,
} from '@agentback/client';
import type {Application} from '@agentback/core';
import type {RestServer} from '@agentback/rest';
import {createRestAppClient} from '@agentback/testlab';
import type {Client as McpSdkClient} from '@modelcontextprotocol/sdk/client/index.js';

const REST_SERVER_KEY = 'servers.RestServer';
const MCP_SERVER_KEY = 'servers.MCPServer';

export interface TestAppOptions {
  /**
   * Binding overrides applied AFTER the application constructor runs —
   * rebinding by key wins. Values are bound with `.to(value)`; classes
   * (detected via `class` syntax) with `.toClass(Ctor)`.
   */
  overrides?: Record<string, unknown>;
  /**
   * Per-binding-key configuration merged over whatever the app configured
   * (`app.configure(key).to(...)`). e.g. `{'servers.RestServer': {basePath: '/api'}}`.
   */
  config?: Record<string, Record<string, unknown>>;
  /**
   * Scopes for the in-memory MCP session — exercises `@authorize`/scope
   * filtered tool visibility exactly like an authenticated HTTP session.
   */
  mcpScopes?: string[];
}

/** Supertest instance type without importing supertest types directly. */
type SupertestClient = ReturnType<typeof createRestAppClient>;

export interface TestApp<
  A extends Application = Application,
> extends AsyncDisposable {
  /** The application under test — use `app.getSync(...)` for DI assertions. */
  readonly app: A;
  /** Base URL of the (ephemeral-port) REST server. Throws if none is bound. */
  readonly url: string;
  /** A `@agentback/client` Client pointed at the test server. */
  readonly client: Client;
  /** Raw supertest, for header/status-level assertions. */
  readonly http: SupertestClient;
  /**
   * In-memory MCP client (SDK `Client`), connected to a session built with
   * `mcpScopes`. Throws if the app has no MCP server bound.
   */
  readonly mcp: McpSdkClient;
  /** Execute a typed route handle against the test server. */
  call<S extends RouteSchemas>(
    handle: RouteHandle<S>,
    input?: Parameters<RouteHandle<S>['call']>[1],
    options?: RouteCallOptions,
  ): Promise<RouteOutput<S>>;
  /** Stop the app and close MCP transports. Idempotent. */
  stop(): Promise<void>;
}

function isClass(fn: unknown): fn is new () => unknown {
  return typeof fn === 'function' && /^class[\s{]/.test(fn.toString());
}

/** Merge config over whatever the app already configured for `key`. */
function mergeConfig(
  app: Application,
  key: string,
  patch: Record<string, unknown>,
) {
  let existing: Record<string, unknown> = {};
  try {
    existing = (app.getConfigSync(key) as Record<string, unknown>) ?? {};
  } catch {
    // No existing config (or it needs async resolution) — start fresh.
  }
  app.configure(key).to({...existing, ...patch});
}

/**
 * Boot an application for tests: apply binding overrides, force an
 * ephemeral REST port and a disabled MCP stdio transport, start, and hand
 * back typed REST + raw HTTP + in-memory MCP clients.
 *
 * ```ts
 * await using t = await createTestApp(MyApplication, {
 *   overrides: {[DB_KEY]: fakeDb},
 * });
 * const order = await t.call(getOrder, {path: {id: '42'}});
 * ```
 */
export async function createTestApp<A extends Application>(
  appOrFactory: A | (new () => A) | (() => A | Promise<A>),
  options: TestAppOptions = {},
): Promise<TestApp<A>> {
  // 1. Materialize the app.
  let app: A;
  if (typeof appOrFactory === 'function') {
    app = isClass(appOrFactory)
      ? new (appOrFactory as new () => A)()
      : await (appOrFactory as () => A | Promise<A>)();
  } else {
    app = appOrFactory;
  }

  // 2. Test-friendly server config: ephemeral port; never grab stdin.
  if (app.isBound(REST_SERVER_KEY)) {
    mergeConfig(app, REST_SERVER_KEY, {
      host: '127.0.0.1',
      port: 0,
      ...(options.config?.[REST_SERVER_KEY] ?? {}),
    });
  }
  if (app.isBound(MCP_SERVER_KEY)) {
    const userCfg = options.config?.[MCP_SERVER_KEY] ?? {};
    mergeConfig(app, MCP_SERVER_KEY, {
      ...userCfg,
      transports: {
        ...(userCfg.transports as object | undefined),
        stdio: false,
      },
    });
  }
  for (const [key, cfg] of Object.entries(options.config ?? {})) {
    if (key === REST_SERVER_KEY || key === MCP_SERVER_KEY) continue;
    mergeConfig(app, key, cfg);
  }

  // 3. Overrides — after the constructor, so rebinding wins.
  for (const [key, value] of Object.entries(options.overrides ?? {})) {
    if (isClass(value)) {
      app.bind(key).toClass(value as new () => object);
    } else {
      app.bind(key).to(value);
    }
  }

  await app.start();

  // 4. REST side.
  let restServer: RestServer | undefined;
  if (app.isBound(REST_SERVER_KEY)) {
    restServer = await app.get<RestServer>(REST_SERVER_KEY);
  }
  const url = restServer?.url;
  const client = url ? createClient({baseURL: url}) : undefined;
  const http = restServer ? createRestAppClient({restServer}) : undefined;

  // 5. MCP side — lazy so apps without @agentback/mcp installed never
  // load it. Type-only imports above carry no runtime dependency.
  let mcpClient: McpSdkClient | undefined;
  let mcpCleanup: (() => Promise<void>) | undefined;
  const initMcp = async (): Promise<McpSdkClient> => {
    if (mcpClient) return mcpClient;
    if (!app.isBound(MCP_SERVER_KEY)) {
      throw new Error(
        `createTestApp: no MCP server bound at '${MCP_SERVER_KEY}' — ` +
          `add MCPComponent to the application to use t.mcp.`,
      );
    }
    const [{InMemoryTransport}, {Client: SdkClient}] = await Promise.all([
      import('@modelcontextprotocol/sdk/inMemory.js'),
      import('@modelcontextprotocol/sdk/client/index.js'),
    ]);
    const mcpServer = (await app.get(MCP_SERVER_KEY)) as {
      buildServer(opts?: {scopes?: string[]}): {
        connect(transport: unknown): Promise<void>;
        close(): Promise<void>;
      };
    };
    const session = mcpServer.buildServer({scopes: options.mcpScopes});
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await session.connect(serverTransport);
    const sdk = new SdkClient({name: 'testing-client', version: '0.0.0'});
    await sdk.connect(clientTransport);
    mcpClient = sdk;
    mcpCleanup = async () => {
      await sdk.close();
      await session.close();
    };
    return sdk;
  };
  // Eagerly connect when an MCP server is present so `t.mcp` is sync.
  if (app.isBound(MCP_SERVER_KEY)) await initMcp();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (mcpCleanup) await mcpCleanup();
    await app.stop();
  };

  return {
    app,
    get url(): string {
      if (!url) throw new Error('createTestApp: no REST server is bound.');
      return url;
    },
    get client(): Client {
      if (!client) throw new Error('createTestApp: no REST server is bound.');
      return client;
    },
    get http(): SupertestClient {
      if (!http) throw new Error('createTestApp: no REST server is bound.');
      return http;
    },
    get mcp(): McpSdkClient {
      if (!mcpClient) {
        throw new Error(
          `createTestApp: no MCP server bound at '${MCP_SERVER_KEY}'.`,
        );
      }
      return mcpClient;
    },
    call(handle, input, callOptions) {
      if (!client) throw new Error('createTestApp: no REST server is bound.');
      return handle.call(
        client,
        input as Parameters<typeof handle.call>[1],
        callOptions,
      );
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
