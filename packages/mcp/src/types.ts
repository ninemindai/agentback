// Copyright ninemind.ai 2026. All Rights Reserved.
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
  transports: {stdio: true},
};
