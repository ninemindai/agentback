// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';

export {Client, StreamableHTTPClientTransport};
export type {OAuthClientProvider, FetchLike};
export * from './oauth.js';

/** A bearer token, or an (async) getter called per request so it can refresh. */
export type TokenSource = string | (() => string | Promise<string>);

export interface ConnectMcpOptions {
  /** URL of the remote server's Streamable HTTP endpoint (e.g. `…/mcp`). */
  url: string | URL;
  /** Client identity sent during `initialize`. */
  name?: string;
  version?: string;
  /**
   * Bearer token (or getter) for an OAuth-protected server. Injected on every
   * request via {@link bearerFetch}; on a `401` the token is re-fetched once
   * (supporting refresh) and the request retried.
   */
  bearerToken?: TokenSource;
  /**
   * Full OAuth client flow (authorization-code/PKCE, refresh) — bring your own
   * `OAuthClientProvider` (the SDK drives discovery + token exchange). Use this
   * for interactive flows; `bearerToken` covers the "already have a token" case.
   */
  authProvider?: OAuthClientProvider;
  /** Custom fetch (advanced); overrides `bearerToken`'s wrapper. */
  fetch?: FetchLike;
  /** Extra request init (headers, etc.). */
  requestInit?: RequestInit;
}

/**
 * Connect to a remote MCP server over Streamable HTTP and return the connected
 * SDK `Client` (plus its transport, e.g. for `transport.sessionId`).
 *
 * @example
 *   const {client} = await connectMcp({url: 'https://api.example.com/mcp'});
 *   await client.listTools();
 *
 * @example  // OAuth-protected server with a (refreshable) bearer token
 *   const {client} = await connectMcp({
 *     url: 'https://api.example.com/mcp',
 *     bearerToken: () => tokenStore.getAccessToken(), // re-called on 401
 *   });
 */
export async function connectMcp(
  options: ConnectMcpOptions,
): Promise<{client: Client; transport: StreamableHTTPClientTransport}> {
  const url =
    typeof options.url === 'string' ? new URL(options.url) : options.url;
  const fetchImpl =
    options.fetch ??
    (options.bearerToken ? bearerFetch(options.bearerToken) : undefined);

  const transport = new StreamableHTTPClientTransport(url, {
    ...(options.authProvider ? {authProvider: options.authProvider} : {}),
    ...(options.requestInit ? {requestInit: options.requestInit} : {}),
    ...(fetchImpl ? {fetch: fetchImpl} : {}),
  });
  const client = new Client({
    name: options.name ?? 'mcp-client',
    version: options.version ?? '0.0.0',
  });
  await client.connect(transport);
  return {client, transport};
}

/**
 * A `fetch` wrapper that adds `Authorization: Bearer <token>` to every request
 * and, on a `401`, re-fetches the token once and retries — so a getter that
 * refreshes transparently recovers from an expired token. If the re-fetched
 * token is unchanged, the `401`
 * is surfaced to the caller.
 */
export function bearerFetch(token: TokenSource): FetchLike {
  const getToken = typeof token === 'function' ? token : () => token;
  const withAuth = (
    input: string | URL,
    init: RequestInit | undefined,
    tok: string,
  ) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${tok}`);
    return fetch(input, {...init, headers});
  };

  return (async (input: string | URL, init?: RequestInit) => {
    const tok = await getToken();
    const res = await withAuth(input, init, tok);
    if (res.status !== 401) return res;
    // 401 → the token may have expired; re-fetch (refresh) and retry once.
    await res.body?.cancel?.().catch(() => {});
    const fresh = await getToken();
    if (fresh === tok) return res; // no new token — surface the 401
    return withAuth(input, init, fresh);
  }) as FetchLike;
}
