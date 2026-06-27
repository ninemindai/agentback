// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  bearerFetch,
  connectMcp,
  finishOAuth,
  LoopbackOAuthProvider,
  startOAuth,
  type Client,
  type FetchLike,
} from '@agentback/mcp-client';
import {assertPublicUrl, guardedFetch} from './ssrf.js';

export {BlockedUrlError} from './ssrf.js';

/** How to authenticate to a remote MCP server. */
export type AuthConfig =
  | {type: 'none'}
  | {type: 'bearer'; token: string}
  | {
      type: 'oauth';
      scope?: string;
      clientId?: string;
      clientSecret?: string;
      /** RFC 8707 resource: pin a value, or `false` to skip the resource check. */
      resource?: string | false;
    };

export interface TargetInfo {
  id: string;
  label: string;
  url: string;
  status: 'connected' | 'authorizing';
}

export interface ManifestData {
  server: {name: string; version: string};
  tools: {
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }[];
  resources: {
    name: string;
    uri: string;
    description?: string;
    mimeType?: string;
  }[];
  prompts: {name: string; description?: string}[];
}

const REQUEST_TIMEOUT = 30000;

/** A read-only view over a connected remote MCP server (an SDK `Client`). */
export class RemoteSource {
  constructor(private readonly client: Client) {}

  async manifest(): Promise<ManifestData> {
    const tools = (
      await this.client.listTools(undefined, {timeout: REQUEST_TIMEOUT})
    ).tools.map(t => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
    }));
    // Only query resources/prompts the server actually advertises — otherwise
    // a server without that capability may not answer the request at all.
    const caps = this.client.getServerCapabilities();
    const resources = caps?.resources
      ? await this.client
          .listResources()
          .then(r =>
            r.resources.map(x => ({
              name: x.name,
              uri: x.uri,
              description: x.description,
              mimeType: x.mimeType,
            })),
          )
          .catch(() => [])
      : [];
    const prompts = caps?.prompts
      ? await this.client
          .listPrompts()
          .then(r =>
            r.prompts.map(p => ({name: p.name, description: p.description})),
          )
          .catch(() => [])
      : [];
    const info = this.client.getServerVersion();
    return {
      server: {name: info?.name ?? 'remote', version: info?.version ?? ''},
      tools,
      resources,
      prompts,
    };
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.client.callTool({name, arguments: args}, undefined, {
      timeout: REQUEST_TIMEOUT,
    });
  }

  /** Remote resources are addressed by URI. */
  readResource(uri: string): Promise<unknown> {
    return this.client.readResource({uri});
  }

  getPrompt(name: string): Promise<unknown> {
    return this.client.getPrompt({name});
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

interface Target {
  info: TargetInfo;
  source?: RemoteSource;
}

interface PendingOAuth {
  targetId: string;
  url: string;
  provider: LoopbackOAuthProvider;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export interface RemoteRegistryOptions {
  /**
   * Allow connecting to loopback / link-local / private / reserved addresses.
   * Default `false`: such URLs are rejected to mitigate SSRF (the API takes a
   * caller-supplied URL and the server connects to it). Set `true` for trusted
   * deployments or local development against `localhost` MCP servers.
   */
  allowPrivateTargets?: boolean;
}

/**
 * Manages a set of remote MCP server connections, each authenticated with no
 * auth, a bearer token, or a full interactive OAuth flow (via
 * `@agentback/mcp-client`). The OAuth authorization-code redirect is
 * completed out of band by {@link completeOAuth} (called from the callback
 * route mounted by `mountMcpConnect`), keyed by the CSRF `state`. A built-in
 * SSRF guard (see {@link RemoteRegistryOptions.allowPrivateTargets}) rejects
 * private/reserved target addresses by default.
 */
export class RemoteRegistry {
  private readonly targets = new Map<string, Target>();
  private readonly pending = new Map<string, PendingOAuth>();
  private seq = 0;
  private readonly allowPrivate: boolean;

  constructor(options: RemoteRegistryOptions = {}) {
    this.allowPrivate = options.allowPrivateTargets ?? false;
  }

  /** Reject an SSRF-unsafe target unless private targets are allowed. */
  private async guard(url: string): Promise<void> {
    if (!this.allowPrivate) await assertPublicUrl(url);
  }

  /** A fetch that blocks private/reserved hosts, composed over `base`; returns
   * `base` unchanged when private targets are allowed. */
  private wrapFetch(base?: FetchLike): FetchLike | undefined {
    if (this.allowPrivate) return base;
    return guardedFetch(base ?? fetch);
  }

  list(): TargetInfo[] {
    return [...this.targets.values()].map(t => t.info);
  }

  source(id: string): RemoteSource | undefined {
    return this.targets.get(id)?.source;
  }

  /**
   * Connect (or begin connecting) to a remote MCP server. For `none`/`bearer`
   * the connection is established immediately. For `oauth`, returns the
   * authorization URL to open; the flow finishes via {@link completeOAuth}.
   * `redirectUri` must be the callback route this registry's mount serves.
   */
  async addTarget(
    url: string,
    auth: AuthConfig,
    redirectUri: string,
  ): Promise<{
    id: string;
    status: 'connected' | 'authorize';
    authorizationUrl?: string;
  }> {
    const id = `remote-${++this.seq}`;
    await this.guard(url);

    if (auth.type === 'oauth') {
      const provider = new LoopbackOAuthProvider({
        redirectUrl: redirectUri,
        clientName: 'AgentBack mcp-connect',
        ...(auth.scope ? {scope: auth.scope} : {}),
        ...(auth.resource !== undefined ? {resource: auth.resource} : {}),
        ...(auth.clientId
          ? {
              clientInformation: {
                client_id: auth.clientId,
                ...(auth.clientSecret
                  ? {client_secret: auth.clientSecret}
                  : {}),
              },
            }
          : {}),
      });
      const fetchFn = this.wrapFetch();
      const begin = await startOAuth(provider, url, {
        ...(auth.scope ? {scope: auth.scope} : {}),
        ...(fetchFn ? {fetchFn} : {}),
      });
      if (begin.status === 'authorized') {
        await this.connect(id, url, provider);
        return {id, status: 'connected'};
      }
      this.targets.set(id, {
        info: {id, label: hostLabel(url), url, status: 'authorizing'},
      });
      this.pending.set(begin.state, {targetId: id, url, provider});
      return {
        id,
        status: 'authorize',
        authorizationUrl: begin.authorizationUrl,
      };
    }

    const base = auth.type === 'bearer' ? bearerFetch(auth.token) : undefined;
    const fetchImpl = this.wrapFetch(base);
    const {client} = await connectMcp({
      url,
      ...(fetchImpl ? {fetch: fetchImpl} : {}),
    });
    this.store(id, url, client);
    return {id, status: 'connected'};
  }

  /** Finish an OAuth flow given the `code` + `state` from the callback. */
  async completeOAuth(state: string, code: string): Promise<{id: string}> {
    const flow = this.pending.get(state);
    if (!flow) throw new Error(`mcp-connect: unknown OAuth state '${state}'`);
    await this.guard(flow.url);
    const fetchFn = this.wrapFetch();
    await finishOAuth(flow.provider, flow.url, code, fetchFn ? {fetchFn} : {});
    await this.connect(flow.targetId, flow.url, flow.provider);
    this.pending.delete(state);
    return {id: flow.targetId};
  }

  async remove(id: string): Promise<void> {
    const t = this.targets.get(id);
    await t?.source?.close().catch(() => {});
    this.targets.delete(id);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.targets.keys()].map(id => this.remove(id)));
  }

  private async connect(
    id: string,
    url: string,
    provider: LoopbackOAuthProvider,
  ): Promise<void> {
    const fetchImpl = this.wrapFetch();
    const {client} = await connectMcp({
      url,
      authProvider: provider,
      ...(fetchImpl ? {fetch: fetchImpl} : {}),
    });
    this.store(id, url, client);
  }

  private store(id: string, url: string, client: Client): void {
    this.targets.set(id, {
      info: {id, label: hostLabel(url), url, status: 'connected'},
      source: new RemoteSource(client),
    });
  }
}
