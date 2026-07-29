// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {UserProfile} from '@agentback/security';

export interface MCPServerConfig {
  /** MCP server name advertised to clients. */
  name?: string;
  /** Server semver version. */
  version?: string;
  /**
   * Ambient identity for transports with no authentication (stdio, direct
   * `callTool`). When set, `@authorize`-gated tools are evaluated against
   * this principal instead of an empty one. Without it, a tool that demands
   * scopes/roles is denied on unauthenticated transports — the safe default.
   */
  localPrincipal?: UserProfile;
  /**
   * Protocol eras this server speaks over **stdio**.
   *
   * - `'legacy'` (default) — the 2025-era `initialize` handshake only, exactly
   *   as a hand-wired `StdioServerTransport` serves it.
   * - `'both'` — serve via the SDK's `serveStdio`, where the opening exchange
   *   selects the era and one instance is pinned for the connection: a
   *   2026-07-28 client is served the modern protocol, a 2025-era client is
   *   still served as before.
   *
   * Opt-in while the ecosystem catches up, mirroring `mcp-http`'s
   * `protocol: 'stateless'`. See
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

export const DEFAULT_MCP_CONFIG: Required<
  Omit<MCPServerConfig, 'transports' | 'localPrincipal'>
> & {transports: NonNullable<MCPServerConfig['transports']>} = {
  name: 'agentback-mcp',
  version: '0.0.0',
  // 2025-era only until the ecosystem catches up; `'both'` is opt-in.
  protocol: 'legacy',
  transports: {stdio: true},
};
