// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Typed client for the mcp-inspector JSON API. Base paths are injected by the
// server shell on `window.__MCP_INSPECTOR__`; falls back to the default mount.
//
// Two backends share one shape (an `Api`): the LOCAL in-process MCP server
// (the inspector's own controller) and any REMOTE MCP server reached through
// `@agentback/mcp-connect`. The UI swaps the active `Api` when you switch
// targets; the cards consume whichever one is current via React context.

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  [k: string]: unknown;
}

export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface ResourceInfo {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
}

export interface PromptInfo {
  name: string;
  description?: string;
}

export interface Manifest {
  server: {name: string; version: string};
  tools: ToolInfo[];
  resources: ResourceInfo[];
  prompts: PromptInfo[];
}

export interface Issue {
  code?: string;
  path?: (string | number)[];
  message?: string;
}

/** Result of an MCP invocation: success carries `result`, failure carries
 * `error` + (when the failure was Zod validation) `issues`. */
export interface Outcome {
  ok: boolean;
  status: number;
  ms: number;
  result?: unknown;
  error?: string;
  issues?: Issue[];
}

export type HistoryKind = 'tool' | 'resource' | 'prompt';

export interface HistoryEntry {
  id: number;
  at: string;
  kind: HistoryKind;
  name: string;
  outcome: Outcome;
}

/** Callback the cards use to push an invocation into the history panel. */
export type RecordFn = (
  kind: HistoryKind,
  name: string,
  outcome: Outcome,
) => void;

/** The operations a card needs, independent of which backend serves them. */
export interface Api {
  fetchManifest(): Promise<Manifest>;
  callTool(name: string, args: Record<string, unknown>): Promise<Outcome>;
  readResource(resource: ResourceInfo): Promise<Outcome>;
  getPrompt(name: string): Promise<Outcome>;
}

/** Remote-connect wiring, supplied by the shell when mcp-connect is mounted. */
export interface ConnectConfig {
  /** mcp-connect JSON API base, e.g. `/mcp-connect/api`. */
  base: string;
  /** OAuth redirect path the popup lands on, e.g. `/mcp-connect/oauth/callback`. */
  callbackPath: string;
}

/** POST to a full URL, normalizing success/error into an {@link Outcome}. Both
 * backends return `{error:{message, details?}}` on failure. */
async function postJson(url: string, body?: unknown): Promise<Outcome> {
  const start = performance.now();
  let status = 0;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body ?? {}),
    });
    status = r.status;
    const ms = Math.round(performance.now() - start);
    const json = await r.json().catch(() => undefined);
    if (r.ok) return {ok: true, status, ms, result: json};
    const err = (json as {error?: {message?: string; details?: Issue[]}})
      ?.error;
    return {
      ok: false,
      status,
      ms,
      error: err?.message ?? 'Request failed (' + status + ')',
      issues: err?.details,
    };
  } catch (e) {
    return {
      ok: false,
      status,
      ms: Math.round(performance.now() - start),
      error: String(e),
    };
  }
}

const enc = encodeURIComponent;

/** The in-process MCP server, via the inspector's own controller at `apiBase`. */
export function localApi(apiBase: string): Api {
  const base = apiBase;
  return {
    async fetchManifest() {
      const r = await fetch(base + '/manifest');
      if (!r.ok) throw new Error('manifest → ' + r.status);
      return (await r.json()) as Manifest;
    },
    callTool: (name, args) =>
      postJson(base + '/tools/' + enc(name) + '/call', args),
    readResource: r => postJson(base + '/resources/' + enc(r.name) + '/read'),
    getPrompt: name => postJson(base + '/prompts/' + enc(name) + '/get'),
  };
}

/** A remote MCP server proxied by mcp-connect at `connectBase` (target `id`). */
export function remoteApi(connectBase: string, id: string): Api {
  const base = connectBase + '/targets/' + enc(id);
  return {
    async fetchManifest() {
      const r = await fetch(base + '/manifest');
      if (!r.ok) throw new Error('manifest → ' + r.status);
      return (await r.json()) as Manifest;
    },
    callTool: (name, args) =>
      postJson(base + '/tools/' + enc(name) + '/call', args),
    // mcp-connect addresses resources by URI, not name.
    readResource: res => postJson(base + '/resources/read', {uri: res.uri}),
    getPrompt: name => postJson(base + '/prompts/' + enc(name) + '/get'),
  };
}

// ---- Remote target management (mcp-connect) --------------------------------

export interface RemoteTarget {
  id: string;
  label: string;
  url: string;
  status: 'connected' | 'authorizing';
}

export type AuthInput =
  | {type: 'none'}
  | {type: 'bearer'; token: string}
  | {type: 'oauth'; scope?: string; resource?: string | false};

export interface AddTargetResult {
  id: string;
  status: 'connected' | 'authorize';
  authorizationUrl?: string;
}

export async function listTargets(
  connectBase: string,
): Promise<RemoteTarget[]> {
  const r = await fetch(connectBase + '/targets');
  if (!r.ok) throw new Error('targets → ' + r.status);
  return (await r.json()) as RemoteTarget[];
}

export async function addTarget(
  connectBase: string,
  url: string,
  auth: AuthInput,
): Promise<AddTargetResult> {
  const r = await fetch(connectBase + '/targets', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({url, auth}),
  });
  const json = (await r.json().catch(() => undefined)) as
    | AddTargetResult
    | {error?: {message?: string}};
  if (!r.ok) {
    throw new Error(
      (json as {error?: {message?: string}})?.error?.message ??
        'add target → ' + r.status,
    );
  }
  return json as AddTargetResult;
}

export async function removeTarget(
  connectBase: string,
  id: string,
): Promise<void> {
  await fetch(connectBase + '/targets/' + enc(id), {method: 'DELETE'});
}
