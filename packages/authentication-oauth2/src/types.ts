// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Minimal `fetch`-shaped function. Injectable so the introspection service can
 * be exercised without a network (bind {@link OAuth2Bindings.FETCH} in tests).
 */
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | URLSearchParams;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * How the resource server authenticates itself to the authorization server's
 * introspection endpoint (RFC 7662 §2.1 leaves this to the AS).
 *
 * - `basic` — HTTP Basic auth header (the most widely supported default).
 * - `post` — `client_id`/`client_secret` in the form body.
 * - `none` — no client auth (public endpoint, or auth carried by `headers`).
 */
export type ClientAuthMethod = 'basic' | 'post' | 'none';

/**
 * Configuration for {@link OAuth2IntrospectionService}. Authorization-server
 * agnostic: point {@link introspectionUrl} at any RFC 7662 endpoint and supply
 * the resource server's own client credentials.
 */
export interface OAuth2IntrospectionConfig {
  /** Absolute URL of the AS token-introspection endpoint (RFC 7662). */
  introspectionUrl: string;
  /** Resource-server client id used to authenticate the introspection call. */
  clientId?: string;
  /** Resource-server client secret paired with {@link clientId}. */
  clientSecret?: string;
  /** Client-auth scheme for the introspection call. Default `basic`. */
  clientAuthMethod?: ClientAuthMethod;
  /** `token_type_hint` sent with the request. Default `access_token`. */
  tokenTypeHint?: string;
  /** Extra static headers (e.g. a gateway key) merged into every call. */
  headers?: Record<string, string>;
  /**
   * Cache active introspection results to avoid a network round-trip per
   * request. `false`/omitted disables it (the default). `true` enables it with
   * defaults; an object tunes the TTL and capacity. Cached lifetime is the
   * lesser of `ttlSeconds` and the token's own `exp`. Negative (inactive)
   * results are never cached.
   */
  cache?: boolean | OAuth2CacheConfig;
}

/** Tuning for the opt-in introspection cache. */
export interface OAuth2CacheConfig {
  /** Max seconds to trust a cached result. Default 60. Bounded by token `exp`. */
  ttlSeconds?: number;
  /** Max cached tokens before the oldest is evicted. Default 1000. */
  maxEntries?: number;
}

/**
 * Configuration for the JWT access-token strategy ({@link JwtAccessTokenService}).
 * For issuers that mint JWT access tokens, verifying the signature locally
 * against the AS's published keys avoids the per-request introspection call.
 */
export interface OAuth2JwtConfig {
  /** Expected `iss`. Reject tokens from any other issuer when set. */
  issuer?: string | string[];
  /** Expected `aud` (your API identifier). Reject mismatches when set. */
  audience?: string | string[];
  /**
   * JWKS endpoint to fetch the AS's signing keys from. Used to build a remote
   * key set when no explicit key resolver is bound under
   * {@link OAuth2JwtBindings.KEY_RESOLVER}.
   */
  jwksUri?: string;
  /** Leeway in seconds for `exp`/`nbf` checks. Default 0. */
  clockToleranceSec?: number;
}

/**
 * The subset of an RFC 7662 introspection response this package reads. `active`
 * is the only field the spec guarantees; everything else is optional and AS
 * dependent. Unknown claims pass through via the index signature.
 */
export interface IntrospectionResponse {
  /** Whether the token is currently active. The one required field. */
  active: boolean;
  /** Space-delimited scope string granted to the token. */
  scope?: string;
  /** Client id the token was issued to. */
  client_id?: string;
  /** Human-readable identifier for the resource owner. */
  username?: string;
  /** Subject — the resource owner's stable id (absent for client tokens). */
  sub?: string;
  /** Expiry as a Unix timestamp (seconds). */
  exp?: number;
  /** Issued-at as a Unix timestamp (seconds). */
  iat?: number;
  /** Not-before as a Unix timestamp (seconds). */
  nbf?: number;
  /** Token type, e.g. `Bearer`. */
  token_type?: string;
  [claim: string]: unknown;
}
