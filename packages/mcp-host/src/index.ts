// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Prompt,
  type ResourceTemplate,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {connectMcp, type TokenSource} from '@agentback/mcp-client';

/** Declares one upstream MCP server to aggregate. */
export type UpstreamConfig = {name: string} & (
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
  def: ResourceTemplate;
  regex: RegExp;
  literalLength: number;
}

interface Upstream {
  name: string;
  client: Client;
}

/** Connect a client to a single upstream MCP server. */
async function connectUpstream(cfg: UpstreamConfig): Promise<Client> {
  if (cfg.transport === 'http') {
    const {client} = await connectMcp({
      url: cfg.url,
      name: 'mcp-host',
      ...(cfg.bearerToken ? {bearerToken: cfg.bearerToken} : {}),
    });
    return client;
  }
  const client = new Client({name: 'mcp-host', version: '0.0.0'});
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
    if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) {
      return fallback;
    }
    throw e;
  };
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
 *   connect.
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

  for (const cfg of options.upstreams) {
    const client = await connectUpstream(cfg);
    clients.push(client);
    // Capability-guarded probing: only query the surfaces the upstream
    // advertises — a server without a capability may reject (or not answer)
    // the request entirely.
    const caps = client.getServerCapabilities();

    if (caps?.tools) {
      const {tools} = await client
        .listTools()
        .catch(emptyOnMethodNotFound({tools: [] as Tool[]}));
      for (const tool of tools) {
        const name = exposed(cfg.name, tool.name);
        if (toolRoutes.has(name)) {
          throw new Error(
            `mcp-host: tool name collision on '${name}'. Enable prefixing or rename.`,
          );
        }
        toolRoutes.set(name, {
          client,
          originalName: tool.name,
          def: {...tool, name},
        });
      }
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
      const {resourceTemplates} = await client
        .listResourceTemplates()
        .catch(
          emptyOnMethodNotFound({resourceTemplates: [] as ResourceTemplate[]}),
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

  const server = new Server(
    {name: options.name ?? 'mcp-host', version: options.version ?? '0.0.0'},
    {
      capabilities: {
        tools: {},
        ...(promptUpstreams.length ? {prompts: {}} : {}),
        ...(resourceUpstreams.length ? {resources: {}} : {}),
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...toolRoutes.values()].map(r => r.def),
  }));

  server.setRequestHandler(CallToolRequestSchema, async req => {
    const route = toolRoutes.get(req.params.name);
    if (!route) {
      throw new Error(`mcp-host: unknown tool '${req.params.name}'`);
    }
    return route.client.callTool({
      name: route.originalName,
      arguments: req.params.arguments ?? {},
    });
  });

  if (promptUpstreams.length) {
    // prompts/list re-queries upstreams per request — no cache.
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
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

    server.setRequestHandler(GetPromptRequestSchema, async req => {
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
      return route.client.getPrompt({
        name: route.originalName,
        ...(req.params.arguments ? {arguments: req.params.arguments} : {}),
      });
    });
  }

  if (resourceUpstreams.length) {
    // resources/list + resources/templates/list re-query per request.
    server.setRequestHandler(ListResourcesRequestSchema, async () => {
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

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      const lists = await Promise.all(
        resourceUpstreams.map(u =>
          u.client
            .listResourceTemplates()
            .catch(
              emptyOnMethodNotFound({
                resourceTemplates: [] as ResourceTemplate[],
              }),
            )
            .then(r => r.resourceTemplates),
        ),
      );
      return {resourceTemplates: lists.flat()};
    });

    server.setRequestHandler(ReadResourceRequestSchema, async req => {
      const {uri} = req.params;
      // Exact URI first (routing map built at connect)…
      const owner = resourceRoutes.get(uri);
      if (owner) return owner.readResource({uri});
      // …then the most specific (longest-literal) matching template.
      const best = templateRoutes
        .filter(t => t.regex.test(uri))
        .sort((a, b) => b.literalLength - a.literalLength)[0];
      if (best) return best.client.readResource({uri});
      throw new Error(`mcp-host: unknown resource '${uri}'`);
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
