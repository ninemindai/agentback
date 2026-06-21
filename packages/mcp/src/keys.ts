// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey, type Context} from '@agentback/context';
import type {ConfirmationStore} from '@agentback/common';
import {MetadataAccessor} from '@agentback/metadata';
import type {SchemaLike} from '@agentback/openapi';
import type {AuthInfo} from '@modelcontextprotocol/sdk/server/auth/types.js';
// Re-exported so tool handlers can type the injected `MCPBindings.REQUEST_AUTH`
// principal (`auth?: AuthInfo`) without reaching into the MCP SDK internals.
export type {AuthInfo} from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {RequestHandlerExtra} from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  RequestInfo,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type {MCPServer, ToolBinding} from './mcp.server.js';

/**
 * The raw SDK per-request extras handed to a tool handler: `signal`,
 * `sessionId`, `requestId`, `_meta`, `sendNotification`, `sendRequest`, ….
 * Escape hatch for advanced tools (elicitation via `sendRequest`, custom
 * notifications). See {@link MCPBindings.REQUEST_EXTRA}.
 */
export type ToolRequestExtra = RequestHandlerExtra<
  ServerRequest,
  ServerNotification
>;

/**
 * Per-request progress reporter for `@tool` methods. Relays
 * `notifications/progress` to the caller when (and only when) the caller asked
 * for progress by sending a `progressToken`; otherwise it is a no-op — tool
 * code never branches. See {@link MCPBindings.PROGRESS}.
 */
export type ProgressFn = (p: {
  progress: number;
  total?: number;
  message?: string;
}) => Promise<void>;

/** The do-nothing {@link ProgressFn} used when no caller asked for progress. */
export const noopProgress: ProgressFn = async () => {};

export namespace MCPBindings {
  export const SERVER = BindingKey.create<MCPServer>('servers.MCPServer');
  /**
   * Per-request authenticated identity (scopes, clientId, …) for the current
   * MCP tool invocation, when the server is exposed over an authenticated
   * transport (see `@agentback/mcp-http`). Inject it into a `@tool`
   * method parameter: `@inject(MCPBindings.REQUEST_AUTH, {optional: true})`.
   * Undefined for stdio / unauthenticated calls.
   */
  export const REQUEST_AUTH = BindingKey.create<AuthInfo>('mcp.request.auth');
  /**
   * The current MCP request's transport info — `headers` and `url` for HTTP
   * transports (see `@agentback/mcp-http`). Lets middleware-style concerns
   * read request headers from a tool's context (e.g. payment proof in
   * `@agentback/payments`). Undefined for stdio.
   */
  export const REQUEST_INFO =
    BindingKey.create<RequestInfo>('mcp.request.info');
  /**
   * The raw SDK `RequestHandlerExtra` for the current MCP tool invocation —
   * the escape hatch for capabilities the framework has not wrapped yet
   * (elicitation / sampling via `extra.sendRequest`, abort `signal`, …).
   * Only bound on transport-driven calls; inject it optionally:
   * `@inject(MCPBindings.REQUEST_EXTRA, {optional: true})`. Undefined for
   * direct `callTool` / inspector invocations. There is deliberately no
   * app-level default for this key.
   */
  export const REQUEST_EXTRA =
    BindingKey.create<ToolRequestExtra>('mcp.request.extra');
  /**
   * Per-request progress reporter. Inject into a `@tool` method parameter:
   * `@inject(MCPBindings.PROGRESS) progress: ProgressFn`. Relays
   * `notifications/progress` when the caller sent a `progressToken`;
   * otherwise (no token, direct `callTool`, inspector) it resolves to a
   * no-op — {@link MCPComponent} binds {@link noopProgress} as the app-level
   * default, so injection never fails.
   */
  export const PROGRESS = BindingKey.create<ProgressFn>('mcp.request.progress');
  /**
   * Store backing `confirm:` tools. Optional — the server falls back to a
   * per-process in-memory store; bind a shared implementation (Redis, …)
   * for multi-instance deployments.
   */
  export const CONFIRMATION_STORE = BindingKey.create<ConfirmationStore>(
    'mcp.confirmationStore',
  );
}

/**
 * Extension-point name for classes that contribute MCP tools/resources/prompts.
 * `@mcpServer()` tags a class `extensionFor: MCP_SERVERS`; the server discovers
 * them with `extensionFilter(MCP_SERVERS)`.
 */
export const MCP_SERVERS = 'mcpServers';

/**
 * Binding tag for {@link McpDispatchHook} values. Bind a hook value and tag
 * it to wrap every tool dispatch:
 *
 * ```ts
 * app
 *   .bind('hooks.audit')
 *   .to(myHook)
 *   .tag(MCP_DISPATCH_HOOK_TAG);
 * ```
 *
 * Hooks compose as an onion in **bind order** — the first-bound hook is the
 * outermost. They wrap the WHOLE `dispatchTool` body, including principal
 * mapping and authorization, so denials surface to hooks as thrown errors.
 * A subclass that overrides `MCPServer.dispatchTool` and calls
 * `super.dispatchTool` runs *outside* the hook chain (subclass first, then
 * hooks, then the tool invocation) — the two seams compose.
 *
 * The resolved hook list is cached on the first dispatched call: hooks must
 * be bound before `app.start()`; later bindings are not picked up.
 */
export const MCP_DISPATCH_HOOK_TAG = 'mcp.dispatchHook';

/** Per-call info passed to an {@link McpDispatchHook}. */
export interface McpDispatchInfo {
  tool: ToolBinding;
  /** The raw (not yet validated) tool input. */
  input: unknown;
  /**
   * The per-request child context. `MCPBindings.REQUEST_AUTH` (and
   * transport extras) are already bound when present; principals
   * (`SecurityBindings.USER`) are bound by the wrapped body, so hooks can
   * read them after `next()` resolves (optional get).
   */
  ctx: Context;
}

/**
 * A cross-cutting wrapper around {@link MCPServer.dispatchTool}. Call
 * `next()` exactly once to run the inner chain (remaining hooks, then the
 * tool); return its result (possibly transformed) or rethrow its errors.
 */
export type McpDispatchHook = (
  info: McpDispatchInfo,
  next: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * Where a host may surface an MCP Apps widget (SEP-1865). `'model'` lets the
 * model reference the widget; `'app'` lets the host render it in the app
 * surface. Omitted → host default policy.
 */
export type ToolUiVisibility = 'model' | 'app';

/**
 * MCP Apps (SEP-1865) UI link for a tool. Declared via `@tool(..., {ui})` and
 * emitted on the tool's `tools/list` entry as `_meta.ui`. The `resourceUri`
 * names a `@resource('ui://…', {mimeType: MCP_APP_MIME_TYPE})` that returns the
 * widget HTML; the widget renders the tool result's `structuredContent` (so the
 * tool should also declare an `output:` schema).
 */
export interface ToolUiMeta {
  /** `ui://` resource URI of the widget HTML this tool renders. */
  resourceUri: string;
  /** Where the host may surface the widget; omitted → host default policy. */
  visibility?: ToolUiVisibility[];
}

/**
 * MIME type marking an HTML `@resource` as an MCP Apps widget (SEP-1865).
 * Use it on the `@resource('ui://…', {mimeType: MCP_APP_MIME_TYPE})` that a
 * tool's `ui.resourceUri` points at, so conformant hosts render it in an
 * iframe instead of treating it as opaque text.
 */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export interface ToolMetadata {
  name: string;
  description?: string;
  title?: string;
  /**
   * MCP Apps (SEP-1865) UI link. When set, the tool's `tools/list` entry
   * carries `_meta.ui.resourceUri` (+ optional `visibility`) so a conformant
   * host renders the named `ui://` widget for this tool's results.
   */
  ui?: ToolUiMeta;
  /**
   * Optional schema for the tool's single input argument — a Zod object or
   * any Standard Schema V1 (`~standard`) vendor able to emit JSON Schema
   * (native capability or a registered converter; see
   * `schemaToOpenApiSchema` in `@agentback/openapi`).
   * When set, the validated input is passed to the method at slot 0 and
   * `@inject(...)` parameters may only appear at slot 1+. When omitted,
   * the tool takes no validated input and slot 0 is free for `@inject`.
   */
  input?: SchemaLike;
  /** Optional schema for the tool's structured output (same kinds as input). */
  output?: SchemaLike;
  /**
   * Optional OAuth scope required to see and call this tool. When the MCP
   * server is exposed over an authenticated transport (see
   * `@agentback/mcp-http`), a session only sees tools whose `scope` is
   * covered by the caller's granted scopes. Tools without a `scope` are always
   * available.
   */
  scope?: string;
  /**
   * Dangerous tool: the first call is refused with a `confirmation_required`
   * error carrying a single-use token bound to the exact input; retrying the
   * identical call with the token in the `confirmationToken` input property
   * executes. `{ttlMs}` overrides the 5-minute token lifetime.
   */
  confirm?: boolean | {ttlMs?: number};
  methodName: string | symbol;
}

export interface ResourceMetadata {
  name: string;
  uri: string;
  description?: string;
  mimeType?: string;
  methodName: string | symbol;
}

export interface PromptMetadata {
  name: string;
  description?: string;
  methodName: string | symbol;
}

export namespace MCPKeys {
  export const TOOL = MetadataAccessor.create<ToolMetadata, MethodDecorator>(
    'mcp:tool',
  );
  export const RESOURCE = MetadataAccessor.create<
    ResourceMetadata,
    MethodDecorator
  >('mcp:resource');
  export const PROMPT = MetadataAccessor.create<
    PromptMetadata,
    MethodDecorator
  >('mcp:prompt');
}
