// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {auth} from '@modelcontextprotocol/sdk/client/auth.js';
import type {OAuthClientProvider} from '@modelcontextprotocol/sdk/client/auth.js';
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * Pluggable persistence for one OAuth session (tokens, registered client,
 * PKCE verifier, CSRF state). Default is in-memory per provider instance; pass
 * your own to persist across processes/requests (e.g. Redis, a DB row).
 */
export interface OAuthStore {
  tokens?: OAuthTokens;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  state?: string;
}

export interface OAuthProviderOptions {
  /**
   * Absolute URL the authorization server redirects back to with the code.
   * Must be a route your app serves (e.g. the inspector's OAuth callback).
   */
  redirectUrl: string | URL;
  /** Client name advertised during dynamic client registration. */
  clientName?: string;
  /** Space-delimited scopes to request. */
  scope?: string;
  /** Pre-registered client (clientId/secret) — skips dynamic registration. */
  clientInformation?: OAuthClientInformationMixed;
  /**
   * RFC 8707 resource indicator handling. A string pins that resource; `false`
   * disables the resource indicator and its match check (use when a server's
   * metadata `resource` doesn't equal the URL you connect to). Default
   * (`undefined`) uses the SDK's standard validation.
   */
  resource?: string | false;
  /** Session persistence; defaults to an in-memory store on this instance. */
  store?: OAuthStore;
}

/**
 * A complete, interactive {@link OAuthClientProvider} for connecting to
 * OAuth-protected MCP servers. Works with the SDK's `auth()` flow to perform
 * RFC 9728 discovery, RFC 7591 dynamic client registration (or a pre-registered
 * client), PKCE, the authorization-code redirect, token exchange, and refresh.
 *
 * In a server context there's no user-agent to redirect, so
 * {@link redirectToAuthorization} captures the URL on {@link authorizationUrl}
 * for the caller to open; see {@link startOAuth} / {@link finishOAuth}.
 */
export class LoopbackOAuthProvider implements OAuthClientProvider {
  private readonly store: OAuthStore;
  /** Set by the SDK when an authorization redirect is required. */
  authorizationUrl?: URL;
  /** Set from `options.resource`; left undefined to use default SDK validation. */
  validateResourceURL?: (
    serverUrl: string | URL,
    resource?: string,
  ) => Promise<URL | undefined>;

  constructor(private readonly options: OAuthProviderOptions) {
    this.store = options.store ?? {};
    if (options.clientInformation) {
      this.store.clientInformation = options.clientInformation;
    }
    if (options.resource !== undefined) {
      const fixed = options.resource;
      this.validateResourceURL = async () =>
        fixed === false ? undefined : new URL(fixed);
    }
  }

  get redirectUrl(): string | URL {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [String(this.options.redirectUrl)],
      client_name: this.options.clientName ?? 'AgentBack',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.options.scope ? {scope: this.options.scope} : {}),
    };
  }

  state(): string {
    // Web Crypto's randomUUID is on `globalThis.crypto` in browsers and Node
    // ≥19, so this module stays isomorphic — no `node:crypto` import means
    // `@agentback/mcp-client` bundles for the browser.
    return (this.store.state ??= globalThis.crypto.randomUUID());
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.store.clientInformation = info;
  }

  tokens(): OAuthTokens | undefined {
    return this.store.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.store.codeVerifier) {
      throw new Error('mcp-client: no PKCE code verifier saved for this flow');
    }
    return this.store.codeVerifier;
  }

  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): void {
    if (scope === 'all' || scope === 'tokens') this.store.tokens = undefined;
    if (scope === 'all' || scope === 'client')
      this.store.clientInformation = undefined;
    if (scope === 'all' || scope === 'verifier')
      this.store.codeVerifier = undefined;
  }

  /** Whether a usable access token is already stored. */
  isAuthorized(): boolean {
    return !!this.store.tokens?.access_token;
  }
}

export type StartOAuthResult =
  | {status: 'authorized'}
  | {status: 'redirect'; authorizationUrl: string; state: string};

/**
 * Begin the OAuth flow for `serverUrl`. Returns `authorized` if valid tokens
 * already exist, otherwise `redirect` with the authorization URL to send the
 * user to (the AS will redirect back to the provider's `redirectUrl` with a
 * `code`; pass it to {@link finishOAuth}).
 */
export async function startOAuth(
  provider: LoopbackOAuthProvider,
  serverUrl: string | URL,
  options: {scope?: string; fetchFn?: FetchLike} = {},
): Promise<StartOAuthResult> {
  const result = await auth(provider, {
    serverUrl,
    ...(options.scope ? {scope: options.scope} : {}),
    ...(options.fetchFn ? {fetchFn: options.fetchFn} : {}),
  });
  if (result === 'AUTHORIZED') return {status: 'authorized'};
  if (!provider.authorizationUrl) {
    throw new Error(
      'mcp-client: OAuth requires a redirect but no authorization URL was produced',
    );
  }
  return {
    status: 'redirect',
    authorizationUrl: provider.authorizationUrl.toString(),
    state: await provider.state(),
  };
}

/**
 * Complete the OAuth flow by exchanging the authorization `code` (from the
 * redirect callback) for tokens. After this resolves the provider holds valid
 * tokens and can be passed to `connectMcp({url, authProvider})`.
 */
export async function finishOAuth(
  provider: LoopbackOAuthProvider,
  serverUrl: string | URL,
  authorizationCode: string,
  options: {fetchFn?: FetchLike} = {},
): Promise<void> {
  const result = await auth(provider, {
    serverUrl,
    authorizationCode,
    ...(options.fetchFn ? {fetchFn: options.fetchFn} : {}),
  });
  if (result !== 'AUTHORIZED') {
    throw new Error('mcp-client: OAuth code exchange did not complete');
  }
}
