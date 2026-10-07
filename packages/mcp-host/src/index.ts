// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {AsyncLocalStorage} from 'node:async_hooks';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {
  Client,
  ProtocolErrorCode,
  type ClientOptions,
} from '@modelcontextprotocol/client';
import {Server, ProtocolError} from '@modelcontextprotocol/server';
import type {
  Prompt,
  RequestId,
  ResourceTemplateType,
  Tool,
  Transport,
} from '@modelcontextprotocol/server';

import {loggers} from '@agentback/common';
import {connectMcp, type TokenSource} from '@agentback/mcp-client';

const log = loggers('agentback:mcp-host');

/** Declares one upstream MCP server to aggregate. */
export type UpstreamConfig = {
  name: string;
  /**
   * How the gateway negotiates the protocol revision with this upstream.
   * `'auto'` (default) speaks 2026-07-28 to an upstream that offers it — so
   * a stateless upstream can still elicit — and falls back to the 2025
   * handshake otherwise; it costs a probe on connect (on stdio, a probe
   * process). `'legacy'` skips the probe and speaks 2025 only.
   */
  versionNegotiation?: 'auto' | 'legacy';
} & (
  | {transport: 'http'; url: string | URL; bearerToken?: TokenSource}
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      /**
       * A pre-built client transport — e.g. one side of
       * `InMemoryTransport.createLinkedPair()` for in-process upstreams/tests.
       */
      transport: 'custom';
      clientTransport: Transport;
    }
);

export interface McpHostOptions {
  /** Upstream servers to aggregate. */
  upstreams: UpstreamConfig[];
  /** Aggregated server identity. */
  name?: string;
  version?: string;
  /**
   * Prefix each tool/prompt name with its upstream's name
   * (`<server>__<name>`) to avoid collisions across upstreams. Default
   * `true`. Resource URIs are never prefixed — they are opaque identifiers
   * clients pass back verbatim; the host routes them by URI instead.
   */
  prefix?: boolean;
  /**
   * Forward a request's vendor `_meta` to the upstream that serves it
   * (`tools/call`, `resources/read`, `prompts/get`). **Off by default**: an
   * upstream authenticates the gateway, not the end client, so a forwarded key
   * arrives under the gateway's credential — an upstream that trusts a
   * host-asserted key (a user id, say) would trust whatever any downstream
   * client sends. Opt in with a list of keys (`['openai/resource']`, the
   * least-privilege form), a predicate, or `true` for every vendor-prefixed
   * key. Reserved `io.modelcontextprotocol/*` keys and `progressToken`
   * describe this hop and never pass, whatever the policy says.
   */
  relayMeta?: boolean | readonly string[] | ((key: string) => boolean);
  /**
   * Let an upstream tool ask the user (elicitation). Default `true`: the
   * gateway declares the `elicitation` capability to every upstream and
   * forwards each question to the downstream client, returning its answer.
   * A downstream client that did not declare `elicitation` gets a clear error
   * instead of a question; with `false`, upstreams see a client that cannot
   * be asked (and answer `elicitation_unavailable` or their own equivalent).
   */
  relayElicitation?: boolean;
  /**
   * How long one question may wait for its answer, and so how long a relayed
   * upstream request may run, in ms. Default 10 minutes — a person is
   * answering, and the SDK's 60 s request default would fail a slow one.
   */
  elicitationTimeoutMs?: number;
}

export interface McpHost {
  /** The aggregated SDK server — connect it to any transport (stdio, or mount
   * over HTTP with `@agentback/mcp-http`'s lower-level helpers). */
  readonly server: Server;
  /** Connect the aggregated server to a transport. */
  connect(transport: Transport): Promise<void>;
  /** Close the aggregated server and all upstream client connections. */
  close(): Promise<void>;
}

interface ToolRoute {
  client: Client;
  originalName: string;
  def: Tool;
}

interface PromptRoute {
  client: Client;
  originalName: string;
}

interface TemplateRoute {
  client: Client;
  def: ResourceTemplateType;
  regex: RegExp;
  literalLength: number;
}

interface Upstream {
  name: string;
  client: Client;
}

/**
 * Connect a client to a single upstream MCP server. Version negotiation is
 * `auto`: a 2026-era upstream is spoken to in its own revision (so a
 * stateless upstream can still elicit, via multi-round-trip results), and an
 * older one falls back to the 2025 handshake.
 */
async function connectUpstream(
  cfg: UpstreamConfig,
  baseOptions: ClientOptions,
  beforeConnect: (client: Client) => void,
): Promise<Client> {
  const clientOptions: ClientOptions =
    cfg.versionNegotiation === 'legacy'
      ? {...baseOptions, versionNegotiation: undefined}
      : baseOptions;
  if (cfg.transport === 'http') {
    const {client} = await connectMcp({
      url: cfg.url,
      name: 'mcp-host',
      ...(cfg.bearerToken ? {bearerToken: cfg.bearerToken} : {}),
      clientOptions,
      beforeConnect,
    });
    return client;
  }
  const client = new Client(
    {name: 'mcp-host', version: '0.0.0'},
    clientOptions,
  );
  beforeConnect(client);
  if (cfg.transport === 'custom') {
    await client.connect(cfg.clientTransport);
    return client;
  }
  await client.connect(
    new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      ...(cfg.env ? {env: cfg.env} : {}),
    }),
  );
  return client;
}

/**
 * Some servers advertise a capability without implementing every method under
 * it (e.g. declare `resources` but no `resources/templates/list` handler).
 * Treat "Method not found" as an empty result; rethrow anything else.
 */
function emptyOnMethodNotFound<T>(fallback: T): (e: unknown) => T {
  return e => {
    if (
      e instanceof ProtocolError &&
      e.code === ProtocolErrorCode.MethodNotFound
    ) {
      return fallback;
    }
    throw e;
  };
}

const RESERVED_META_PREFIX = 'io.modelcontextprotocol/';

/** The vendor `_meta` keys of a request worth forwarding upstream. */
function relayableMeta(
  meta: Record<string, unknown> | undefined,
  policy: boolean | readonly string[] | ((key: string) => boolean),
): Record<string, unknown> | undefined {
  if (!meta || policy === false) return undefined;
  const allow =
    typeof policy === 'function'
      ? policy
      : Array.isArray(policy)
        ? (key: string) => policy.includes(key)
        : (key: string) =>
            key.includes('/') && !key.startsWith(RESERVED_META_PREFIX);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    // Reserved keys never pass, whatever the predicate says: they describe
    // this hop (the client's protocol envelope), not the upstream's.
    if (k.startsWith(RESERVED_META_PREFIX) || k === 'progressToken') continue;
    if (allow(k)) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Compile an RFC 6570 URI template into a conservative matcher.
 *
 * Limits (documented, deliberate): only simple `{var}` expansion is matched
 * precisely — a variable matches one or more non-`/` characters. Reserved
 * (`{+var}`) and fragment (`{#var}`) expansions match any non-empty string.
 * Other operators (`{?q}`, `{.ext}`, `{/path}`, `{;p}`, `{&p}`) and
 * explode/prefix modifiers are treated like `{var}` — good enough to route a
 * read to its owning upstream, not a full RFC 6570 implementation.
 * `literalLength` (the number of non-variable characters) is the specificity
 * score used for longest-literal-match routing.
 */
export function compileUriTemplate(uriTemplate: string): {
  regex: RegExp;
  literalLength: number;
} {
  let pattern = '';
  let literalLength = 0;
  let last = 0;
  const varRe = /\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = varRe.exec(uriTemplate))) {
    const literal = uriTemplate.slice(last, m.index);
    literalLength += literal.length;
    pattern += escapeRegExp(literal);
    const op = m[1][0];
    pattern += op === '+' || op === '#' ? '.+' : '[^/]+';
    last = m.index + m[0].length;
  }
  const tail = uriTemplate.slice(last);
  literalLength += tail.length;
  pattern += escapeRegExp(tail);
  return {regex: new RegExp(`^${pattern}$`), literalLength};
}

/**
 * Build an MCP **gateway**: connect to several upstream MCP servers (stdio
 * child processes, remote HTTP servers, or pre-built transports), merge their
 * tools, prompts, and resources into one surface, and proxy calls to the
 * owning upstream. The returned aggregated `Server` can be exposed over any
 * transport — including, authenticated, over HTTP via
 * `@agentback/mcp-http`.
 *
 * Aggregation semantics:
 * - **Tools/prompts** are namespaced `<upstream>__<name>` (unless
 *   `prefix: false`); name collisions throw at connect.
 * - **Resources** keep their URIs; a routing map built from `resources/list`
 *   at connect routes `resources/read` by exact URI. Duplicate URIs across
 *   upstreams throw at connect — an ambiguous gateway is a misconfiguration.
 *   Template-expanded URIs route to the upstream whose template matches with
 *   the most literal (non-variable) characters; exact duplicate templates
 *   across upstreams throw at connect.
 * - `resources/list`, `resources/templates/list`, and `prompts/list`
 *   re-query upstreams per request (no cache). `tools/list` is cached at
 *   connect and re-synced, per upstream, when that upstream announces
 *   `notifications/tools/list_changed`; the gateway then announces the same
 *   to its own client. An upstream that does not advertise
 *   `tools.listChanged` is never re-synced. A tool name that a re-sync finds
 *   already owned by another upstream keeps its existing owner (logged) —
 *   at connect the same collision throws.
 * - The aggregate declares the `resources`/`prompts` capability only when at
 *   least one upstream advertises it.
 *
 * @example
 *   const host = await createMcpHost({
 *     upstreams: [
 *       {name: 'notion', transport: 'stdio', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server']},
 *       {name: 'weather', transport: 'http', url: 'https://weather.example.com/mcp', bearerToken: tok},
 *     ],
 *   });
 *   await host.connect(myTransport); // e.g. stdio, or a StreamableHTTPServerTransport
 */
export async function createMcpHost(options: McpHostOptions): Promise<McpHost> {
  const prefix = options.prefix ?? true;
  const clients: Client[] = [];
  const toolRoutes = new Map<string, ToolRoute>();
  const promptRoutes = new Map<string, PromptRoute>();
  const resourceRoutes = new Map<string, Client>();
  const templateRoutes: TemplateRoute[] = [];
  const promptUpstreams: Upstream[] = [];
  const resourceUpstreams: Upstream[] = [];

  const exposed = (upstream: string, name: string) =>
    prefix ? `${upstream}__${name}` : name;
  const relayMetaPolicy = options.relayMeta ?? false;
  const relayElicitation = options.relayElicitation ?? true;
  const elicitationTimeoutMs = options.elicitationTimeoutMs ?? 600_000;
  // A relayed request may wait on a person answering an upstream's question.
  const upstreamRequestOptions = relayElicitation
    ? {timeout: elicitationTimeoutMs}
    : undefined;
  // Which downstream request an upstream's question belongs to, so it is
  // sent on that request's stream (a Streamable HTTP downstream drops a
  // server→client request with no related request and no standalone stream).
  // The async context covers questions raised inside the upstream call (the
  // 2026 multi-round-trip driver); a 2025 upstream session delivers its
  // `elicitation/create` from the connection instead, so fall back to the one
  // downstream request in flight on that upstream when there is exactly one.
  const relayContext = new AsyncLocalStorage<RequestId>();
  const inFlight = new Map<Client, Set<RequestId>>();
  const relayed = async <T>(
    client: Client,
    id: RequestId,
    fn: () => Promise<T>,
  ): Promise<T> => {
    let ids = inFlight.get(client);
    if (!ids) inFlight.set(client, (ids = new Set()));
    ids.add(id);
    try {
      return await relayContext.run(id, fn);
    } finally {
      ids.delete(id);
    }
  };
  const relatedRequestFor = (client: Client): RequestId | undefined => {
    const current = relayContext.getStore();
    if (current !== undefined) return current;
    const ids = inFlight.get(client);
    return ids?.size === 1 ? [...ids][0] : undefined;
  };
  const metaOf = (params: {_meta?: Record<string, unknown>}) => {
    const _meta = relayableMeta(params._meta, relayMetaPolicy);
    return _meta ? {_meta} : {};
  };

  // The aggregated server, created up front so upstream elicitation handlers
  // can reach the downstream client through it.
  const server = new Server(
    {name: options.name ?? 'mcp-host', version: options.version ?? '0.0.0'},
    {capabilities: {tools: {listChanged: true}}},
  );

  /**
   * Replace one upstream's tool routes with `tools`. Builds the new set
   * first and swaps it in synchronously, so a concurrent `tools/call` sees
   * either the old routes or the new ones, never a mix.
   */
  const setToolRoutes = (
    upstream: string,
    client: Client,
    tools: Tool[],
    onCollision: (name: string) => void,
  ) => {
    const next = new Map<string, ToolRoute>();
    for (const tool of tools) {
      const name = exposed(upstream, tool.name);
      const owner = toolRoutes.get(name)?.client;
      if (next.has(name) || (owner && owner !== client)) {
        onCollision(name);
        continue;
      }
      next.set(name, {client, originalName: tool.name, def: {...tool, name}});
    }
    for (const [name, route] of toolRoutes) {
      if (route.client === client) toolRoutes.delete(name);
    }
    for (const [name, route] of next) toolRoutes.set(name, route);
  };

  /** Client options for one upstream: re-sync its tools on list_changed. */
  const optionsFor = (
    cfg: UpstreamConfig,
    current: () => Client | undefined,
  ): ClientOptions => ({
    ...clientOptions,
    listChanged: {
      tools: {
        onChanged: (error, tools) => {
          const client = current();
          // Before connect returns, the connect-time listing below wins.
          if (!client) return;
          if (error || !tools) {
            log.warn(
              'upstream %s announced a tool change but re-listing failed: %s',
              cfg.name,
              error?.message ?? 'no tools returned',
            );
            return;
          }
          setToolRoutes(cfg.name, client, tools, name =>
            log.warn(
              "upstream %s re-listed tool '%s', already owned by another upstream; keeping the existing owner",
              cfg.name,
              name,
            ),
          );
          // Fails when no downstream client is connected yet, which is fine.
          server
            .sendToolListChanged()
            .catch(e =>
              log.debug('downstream tools list_changed not delivered: %s', e),
            );
        },
      },
    },
  });

  const clientOptions: ClientOptions = {
    versionNegotiation: {mode: 'auto'},
    ...(relayElicitation ? {capabilities: {elicitation: {form: {}}}} : {}),
  };
  const beforeConnect = (client: Client) => {
    if (!relayElicitation) return;
    // An upstream's question goes to the one downstream client this gateway
    // serves. A 2025 upstream session sends `elicitation/create` here; for a
    // 2026 upstream the client SDK drives the multi-round-trip result and
    // calls this same handler.
    client.setRequestHandler('elicitation/create', async req => {
      if (!server.getClientCapabilities()?.elicitation) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidRequest,
          'mcp-host: an upstream tool asked the user a question, but the ' +
            'client connected to this gateway did not declare elicitation',
        );
      }
      const relatedRequestId = relatedRequestFor(client);
      return server.elicitInput(req.params, {
        timeout: elicitationTimeoutMs,
        ...(relatedRequestId !== undefined ? {relatedRequestId} : {}),
      });
    });
  };

  for (const cfg of options.upstreams) {
    let connected: Client | undefined;
    const client = await connectUpstream(
      cfg,
      optionsFor(cfg, () => connected),
      beforeConnect,
    );
    connected = client;
    clients.push(client);
    // Capability-guarded probing: only query the surfaces the upstream
    // advertises — a server without a capability may reject (or not answer)
    // the request entirely.
    const caps = client.getServerCapabilities();

    if (caps?.tools) {
      const {tools} = await client
        .listTools()
        .catch(emptyOnMethodNotFound({tools: [] as Tool[]}));
      setToolRoutes(cfg.name, client, tools, name => {
        throw new Error(
          `mcp-host: tool name collision on '${name}'. Enable prefixing or rename.`,
        );
      });
    }

    if (caps?.prompts) {
      promptUpstreams.push({name: cfg.name, client});
      const {prompts} = await client
        .listPrompts()
        .catch(emptyOnMethodNotFound({prompts: [] as Prompt[]}));
      for (const prompt of prompts) {
        const name = exposed(cfg.name, prompt.name);
        if (promptRoutes.has(name)) {
          throw new Error(
            `mcp-host: prompt name collision on '${name}'. Enable prefixing or rename.`,
          );
        }
        promptRoutes.set(name, {client, originalName: prompt.name});
      }
    }

    if (caps?.resources) {
      resourceUpstreams.push({name: cfg.name, client});
      const {resources} = await client
        .listResources()
        .catch(emptyOnMethodNotFound({resources: []}));
      for (const resource of resources) {
        if (resourceRoutes.has(resource.uri)) {
          throw new Error(
            `mcp-host: resource URI collision on '${resource.uri}' (URIs are opaque and cannot be prefixed — rename it on one upstream).`,
          );
        }
        resourceRoutes.set(resource.uri, client);
      }
      const {resourceTemplates} = await client.listResourceTemplates().catch(
        emptyOnMethodNotFound({
          resourceTemplates: [] as ResourceTemplateType[],
        }),
      );
      for (const def of resourceTemplates) {
        if (templateRoutes.some(t => t.def.uriTemplate === def.uriTemplate)) {
          throw new Error(
            `mcp-host: resource template collision on '${def.uriTemplate}' — reads would be ambiguous.`,
          );
        }
        templateRoutes.push({
          client,
          def,
          ...compileUriTemplate(def.uriTemplate),
        });
      }
    }
  }

  // Legal until the server connects, which the caller does after this.
  server.registerCapabilities({
    ...(promptUpstreams.length ? {prompts: {}} : {}),
    ...(resourceUpstreams.length ? {resources: {}} : {}),
  });

  server.setRequestHandler('tools/list', async () => ({
    tools: [...toolRoutes.values()].map(r => r.def),
  }));

  server.setRequestHandler('tools/call', async (req, ctx) => {
    const route = toolRoutes.get(req.params.name);
    if (!route) {
      throw new Error(`mcp-host: unknown tool '${req.params.name}'`);
    }
    return relayed(route.client, ctx.mcpReq.id, () =>
      route.client.callTool(
        {
          name: route.originalName,
          arguments: req.params.arguments ?? {},
          ...metaOf(req.params),
        },
        upstreamRequestOptions,
      ),
    );
  });

  if (promptUpstreams.length) {
    // prompts/list re-queries upstreams per request — no cache.
    server.setRequestHandler('prompts/list', async () => {
      const lists = await Promise.all(
        promptUpstreams.map(async u => {
          const {prompts} = await u.client
            .listPrompts()
            .catch(emptyOnMethodNotFound({prompts: [] as Prompt[]}));
          return prompts.map(p => ({...p, name: exposed(u.name, p.name)}));
        }),
      );
      return {prompts: lists.flat()};
    });

    server.setRequestHandler('prompts/get', async (req, ctx) => {
      const {name} = req.params;
      let route = promptRoutes.get(name);
      if (!route && prefix) {
        // Prompt appeared after connect: strip the longest matching upstream
        // prefix and proxy.
        const owner = [...promptUpstreams]
          .sort((a, b) => b.name.length - a.name.length)
          .find(u => name.startsWith(`${u.name}__`));
        if (owner) {
          route = {
            client: owner.client,
            originalName: name.slice(owner.name.length + 2),
          };
        }
      }
      if (!route) throw new Error(`mcp-host: unknown prompt '${name}'`);
      const {client: owner, originalName} = route;
      return relayed(owner, ctx.mcpReq.id, () =>
        owner.getPrompt(
          {
            name: originalName,
            ...(req.params.arguments ? {arguments: req.params.arguments} : {}),
            ...metaOf(req.params),
          },
          upstreamRequestOptions,
        ),
      );
    });
  }

  if (resourceUpstreams.length) {
    // resources/list + resources/templates/list re-query per request.
    server.setRequestHandler('resources/list', async () => {
      const lists = await Promise.all(
        resourceUpstreams.map(u =>
          u.client
            .listResources()
            .catch(emptyOnMethodNotFound({resources: []}))
            .then(r => r.resources),
        ),
      );
      return {resources: lists.flat()};
    });

    server.setRequestHandler('resources/templates/list', async () => {
      const lists = await Promise.all(
        resourceUpstreams.map(u =>
          u.client
            .listResourceTemplates()
            .catch(
              emptyOnMethodNotFound({
                resourceTemplates: [] as ResourceTemplateType[],
              }),
            )
            .then(r => r.resourceTemplates),
        ),
      );
      return {resourceTemplates: lists.flat()};
    });

    server.setRequestHandler('resources/read', async (req, ctx) => {
      const {uri} = req.params;
      // Exact URI first (routing map built at connect), then the most
      // specific (longest-literal) matching template.
      const owner =
        resourceRoutes.get(uri) ??
        templateRoutes
          .filter(t => t.regex.test(uri))
          .sort((a, b) => b.literalLength - a.literalLength)[0]?.client;
      if (!owner) throw new Error(`mcp-host: unknown resource '${uri}'`);
      return relayed(owner, ctx.mcpReq.id, () =>
        owner.readResource(
          {uri, ...metaOf(req.params)},
          upstreamRequestOptions,
        ),
      );
    });
  }

  return {
    server,
    connect: transport => server.connect(transport),
    async close() {
      await server.close().catch(() => {});
      await Promise.all(clients.map(c => c.close().catch(() => {})));
    },
  };
}

/** Fluent builder for {@link UpstreamConfig}s. */
export class McpHostBuilder {
  private readonly upstreams: UpstreamConfig[] = [];

  http(
    name: string,
    url: string | URL,
    opts: {bearerToken?: TokenSource} = {},
  ): this {
    this.upstreams.push({name, transport: 'http', url, ...opts});
    return this;
  }

  stdio(
    name: string,
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
  ): this {
    this.upstreams.push({
      name,
      transport: 'stdio',
      command,
      args,
      ...(env ? {env} : {}),
    });
    return this;
  }

  /** Aggregate an upstream over a pre-built client transport (e.g. in-memory). */
  custom(name: string, clientTransport: Transport): this {
    this.upstreams.push({name, transport: 'custom', clientTransport});
    return this;
  }

  build(): UpstreamConfig[] {
    return [...this.upstreams];
  }
}

export const mcpHostBuilder = () => new McpHostBuilder();
