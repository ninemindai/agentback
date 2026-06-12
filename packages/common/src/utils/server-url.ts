// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {getEnvVar} from './env.js';

/**
 * Resolve this service's externally-visible HTTPS URL.
 *
 * Reads `SERVER_URL` (set in production by the deploy task definition,
 * e.g. `https://api.example.com`). Falls back to
 * `http://localhost:${PORT ?? 3000}` for local development.
 *
 * Used by JWT (issuer/audience), MCP relay (websocket origin),
 * OAuth2 (callback URL composition), and anywhere else that needs
 * "where am I reachable from."
 */
export function getServerURL(): string {
  const explicit = getEnvVar('SERVER_URL');
  if (explicit) return explicit;
  const port = getEnvVar('PORT', '3000');
  return `http://localhost:${port}`;
}

/**
 * WebSocket URL of the agent relay, derived from {@link getServerURL}.
 *
 * Swaps the scheme (`https`→`wss`, `http`→`ws`) and appends
 * `/ws/agent-relay`, so it honors `SERVER_URL` in production
 * (e.g. `wss://api.example.com/ws/agent-relay`) and falls back to
 * `ws://localhost:${PORT ?? 3000}/ws/agent-relay` in local development.
 *
 * Use for the relay default in client packages (CLI, relay, and sandbox
 * clients) instead of hardcoding a host.
 */
export function getRelayURL(): string {
  const base = getServerURL().replace(/\/+$/, '');
  const ws = base.replace(/^http/, 'ws');
  return `${ws}/ws/agent-relay`;
}
