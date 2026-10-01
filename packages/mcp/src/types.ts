// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {UserProfile} from '@agentback/security';
import type {Icon, JSONObject} from '@modelcontextprotocol/server';

/**
 * MCP Events subscription policy (`events/subscribe`). Every field has a
 * default; see `DEFAULT_EVENTS_CONFIG`.
 */
export interface McpEventsConfig {
  /** TTL granted when the client suggests none (default 1 h). */
  defaultTtlMs?: number;
  /**
   * Floor a shorter `ttlMs` suggestion is clamped up to, so clients cannot
   * cause refresh storms (default 60 s).
   */
  minTtlMs?: number;
  /** Ceiling a longer suggestion is clamped down to (default 24 h). */
  maxTtlMs?: number;
  /**
   * Honour `ttlMs: null` with `refreshBefore: null` (no expiry). Off by
   * default: a server that grants no expiry MUST keep the subscription across
   * restarts, which the in-memory store cannot. Turn on only with a durable
   * `MCPBindings.SUBSCRIPTION_STORE`.
   */
  allowNoExpiry?: boolean;
  /** Live subscriptions one principal may hold (default 100) ⇒ `-32013`. */
  maxSubscriptionsPerPrincipal?: number;
  /**
   * How long a secret replaced by a refresh keeps signing beside the new
   * one, so in-flight deliveries verify under either (default 5 min).
   */
  secretRotationGraceMs?: number;
  /**
   * How long a passed endpoint verification covers a `(principal, url)`
   * before the next subscribe re-verifies it (default 1 h).
   */
  verificationTtlMs?: number;
}

export interface MCPServerConfig {
  /** MCP server name advertised to clients. */
  name?: string;
  /** Server semver version. */
  version?: string;
  /** Human-readable server title, advertised in the server info. */
  title?: string;
  /**
   * Server icons, advertised in the server info. Hosts fall back to them for
   * entrypoints whose tools declare no icon. On protocol `2026-07-28` the
   * server info rides on **every** result's `_meta`, so prefer `https` URLs —
   * a data URI over ~1 KB logs a warning at boot.
   */
  icons?: Icon[];
  /** Server website, advertised in the server info. */
  websiteUrl?: string;
  /**
   * Extra server capabilities — host or vendor extensions advertised under
   * `capabilities.extensions` (and the legacy `capabilities.experimental`),
   * e.g. `{extensions: {'openai/settings': {readTool, updateTool}}}`. They
   * appear on `initialize` (2025 era) and `server/discover` (2026). Only these
   * two keys are accepted; `tools`/`resources`/`prompts` stay framework-owned.
   */
  capabilities?: {
    extensions?: Record<string, JSONObject>;
    experimental?: Record<string, JSONObject>;
  };
  /**
   * Ambient identity for transports with no authentication (stdio, direct
   * `callTool`). When set, `@authorize`-gated tools are evaluated against
   * this principal instead of an empty one. Without it, a tool that demands
   * scopes/roles is denied on unauthenticated transports — the safe default.
   */
  localPrincipal?: UserProfile;
  /** MCP Events subscription policy; see {@link McpEventsConfig}. */
  events?: McpEventsConfig;
  /**
   * Protocol eras this server speaks over **stdio**.
   *
   * - `'both'` (**default**) — serve via the SDK's `serveStdio`, where the
   *   opening exchange selects the era and one instance is pinned for the
   *   connection: a 2026-07-28 client is served the modern protocol, a
   *   2025-era client is still served exactly as before.
   * - `'legacy'` — the 2025-era `initialize` handshake only, exactly as a
   *   hand-wired `StdioServerTransport` serves it. The rollback switch.
   *
   * The default flipped to `'both'` because it is strictly additive over stdio:
   * there is no session concept here, so serving the modern era costs a 2025
   * client nothing. Verified against real spawned processes in
   * `stdio-eras.integration.ts`. Mirrors `mcp-http`'s `protocol`. See
   * [docs/proposals/mcp-2026-stateless.md](../../../docs/proposals/mcp-2026-stateless.md).
   *
   * Note that on a 2026-pinned connection the SDK's `getClientCapabilities()` /
   * `getClientVersion()` return `undefined` — there is no `initialize` to read
   * them from. Nothing in AgentBack consumes those today.
   */
  protocol?: 'legacy' | 'both';
  /** Transports to enable. */
  transports?: {
    stdio?: boolean;
    /**
     * If set, mount a Streamable HTTP transport on this port. If you want it
     * mounted on an existing Express app/path, use mountHttpTransport from
     * mcp.server.ts manually instead.
     */
    httpPort?: number;
  };
}

/** Optional {@link MCPServerConfig} keys with no default. */
export type MCPServerOptionalKeys =
  | 'transports'
  | 'localPrincipal'
  | 'title'
  | 'icons'
  | 'websiteUrl'
  | 'capabilities'
  | 'events';

export const DEFAULT_MCP_CONFIG: Required<
  Omit<MCPServerConfig, MCPServerOptionalKeys>
> & {transports: NonNullable<MCPServerConfig['transports']>} = {
  name: 'agentback-mcp',
  version: '0.0.0',
  // Serve both eras (0.9.0). Strictly additive over stdio — there is no
  // session concept here, so a 2025 client is unaffected. `'legacy'` opts out.
  protocol: 'both',
  transports: {stdio: true},
};
