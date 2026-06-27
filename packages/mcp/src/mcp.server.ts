// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  config,
  Context,
  inject,
  resolveInjectedArguments,
} from '@agentback/context';
import {
  AuthorizationDecision,
  AuthorizationKeys,
  buildAuthorizationContext,
  getAuthorizationMetadata,
  runAuthorization,
  type AuthorizationMetadata,
} from '@agentback/authorization';
import {SecurityBindings, type UserProfile} from '@agentback/security';
import {extensionFilter, Server} from '@agentback/core';
import {MetadataAccessor, MetadataInspector} from '@agentback/metadata';
import {
  buildErrorEnvelope,
  ErrorCodes,
  schemaToOpenApiSchema,
  standardParse,
  type ParseIssue,
  type SchemaLike,
} from '@agentback/openapi';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  InMemoryConfirmationStore,
  loggers,
  stableStringify,
  type ConfirmationStore,
} from '@agentback/common';
import type {ZodType} from 'zod';
import {
  MCP_DISPATCH_HOOK_TAG,
  MCP_SERVERS,
  MCPBindings,
  MCPKeys,
  noopProgress,
  PromptMetadata,
  ResourceMetadata,
  ToolMetadata,
  type McpDispatchHook,
  type McpDispatchInfo,
  type ProgressFn,
  type ToolRequestExtra,
} from './keys.js';
import {
  authInfoToPrincipals,
  requiredScopesForMember,
  requiredScopesForTool,
} from './policy.js';
import {DEFAULT_MCP_CONFIG, type MCPServerConfig} from './types.js';
import {toolCostReport, type ToolCostReport} from './tool-cost.js';

const log = loggers('agentback:mcp:server');

export interface ToolBinding {
  ctor: Function;
  meta: ToolMetadata;
}

export class MCPServer implements Server {
  private mcp: McpServer;
  private _listening = false;
  private stdioTransport?: StdioServerTransport;
  /** Tools already reported as class-level-gated (one log line per tool). */
  private warnedClassGated = new Set<string>();
  readonly config: Required<
    Omit<MCPServerConfig, 'transports' | 'localPrincipal'>
  > & {
    transports: NonNullable<MCPServerConfig['transports']>;
    localPrincipal?: UserProfile;
  };

  constructor(
    // Inject the binding's own resolution context rather than the app root.
    // For the app-level singleton this still resolves to the application
    // context (a singleton resolves against its owner context), so existing
    // behavior is unchanged. But when MCPServer is bound request/user-scoped
    // in a child context, `this.context` becomes that child — so tool
    // discovery (`find(extensionFilter(MCP_SERVERS))`, a chain walk) and the
    // per-request children built off it (`requestContextFor`) see both the
    // shared app-level tools AND any tools bound into the user context.
    @inject.context()
    protected context: Context,
    @config()
    cfg: MCPServerConfig = {},
  ) {
    this.config = {
      ...DEFAULT_MCP_CONFIG,
      ...cfg,
      transports: {
        ...DEFAULT_MCP_CONFIG.transports,
        ...(cfg?.transports ?? {}),
      },
    };
    this.mcp = new McpServer(
      {name: this.config.name, version: this.config.version},
      {capabilities: {tools: {}, resources: {}, prompts: {}}},
    );
  }

  get listening(): boolean {
    return this._listening;
  }

  /** The underlying MCP SDK server (escape hatch). */
  get sdkServer(): McpServer {
    return this.mcp;
  }

  /** Public introspection: list every registered tool. */
  listTools(): ToolBinding[] {
    return this.collectAllTools();
  }

  /**
   * Price the tool surface: estimated token cost of every tool's
   * `tools/list` entry (name + description + emitted JSON Schemas) and the
   * total a caller's context window pays per `tools/list`. Render with
   * {@link formatToolCostReport}.
   */
  toolCostReport(): ToolCostReport {
    return toolCostReport(
      this.collectAllTools().map(t => ({
        name: t.meta.name,
        title: t.meta.title,
        description: t.meta.description,
        inputSchema: t.meta.input
          ? schemaToOpenApiSchema(t.meta.input)
          : {type: 'object'},
        outputSchema: t.meta.output
          ? schemaToOpenApiSchema(t.meta.output)
          : undefined,
      })),
    );
  }

  /** Public introspection: list every registered resource. */
  listResources(): {ctor: Function; meta: ResourceMetadata}[] {
    return this.collectAllResources();
  }

  /** Public introspection: list every registered prompt. */
  listPrompts(): {ctor: Function; meta: PromptMetadata}[] {
    return this.collectAllPrompts();
  }

  /**
   * Invoke a tool by name with the given input object. Runs the same Zod
   * validation + dispatch path as the SDK-registered handler. Used by the
   * mcp-inspector UI to exercise tools without going through MCP transport.
   */
  async callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = this.collectAllTools().find(t => t.meta.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return this.dispatchTool(tool, input);
  }

  /**
   * Read a resource by name, returning the same `{contents: [...]}` shape an
   * MCP client receives. Shares the dispatch path with the SDK-registered
   * handler. Used by the mcp-inspector UI.
   */
  async readResource(
    name: string,
  ): Promise<{contents: {uri: string; mimeType: string; text: string}[]}> {
    const resource = this.collectAllResources().find(r => r.meta.name === name);
    if (!resource) throw new Error(`Unknown resource: ${name}`);
    return this.dispatchResource(resource);
  }

  /**
   * Get a prompt by name, returning the same `{messages: [...]}` shape an MCP
   * client receives. Shares the dispatch path with the SDK-registered handler.
   * Used by the mcp-inspector UI.
   */
  async getPrompt(name: string): Promise<{
    messages: {role: 'user'; content: {type: 'text'; text: string}}[];
  }> {
    const prompt = this.collectAllPrompts().find(p => p.meta.name === name);
    if (!prompt) throw new Error(`Unknown prompt: ${name}`);
    return this.dispatchPrompt(prompt);
  }

  /**
   * Invoke a resource method and wrap the result in the MCP contents shape.
   * Runs the same principal mapping + `@authorize` voter chain as tools, in
   * a per-request child context — one policy, every member kind.
   */
  protected async dispatchResource(
    resource: {
      ctor: Function;
      meta: ResourceMetadata;
    },
    ctx: Context = this.context,
  ): Promise<{contents: {uri: string; mimeType: string; text: string}[]}> {
    const reqCtx =
      ctx === this.context ? new Context(this.context, 'mcp.request') : ctx;
    const user = await this.bindRequestPrincipals(reqCtx);
    await this.authorizeMember(
      resource.ctor,
      resource.meta.methodName as string,
      user,
      reqCtx,
    );
    const instance = (await this.resolveMember(
      resource.ctor,
      reqCtx,
    )) as Record<string, Function>;
    const result =
      await instance[resource.meta.methodName as string].call(instance);
    return {
      contents: [
        {
          uri: resource.meta.uri,
          mimeType: resource.meta.mimeType ?? 'text/plain',
          text: typeof result === 'string' ? result : JSON.stringify(result),
        },
      ],
    };
  }

  /**
   * Invoke a prompt method and wrap the result in the MCP messages shape.
   * Same per-request policy pipeline as resources/tools.
   */
  protected async dispatchPrompt(
    prompt: {
      ctor: Function;
      meta: PromptMetadata;
    },
    ctx: Context = this.context,
  ): Promise<{
    messages: {role: 'user'; content: {type: 'text'; text: string}}[];
  }> {
    const reqCtx =
      ctx === this.context ? new Context(this.context, 'mcp.request') : ctx;
    const user = await this.bindRequestPrincipals(reqCtx);
    await this.authorizeMember(
      prompt.ctor,
      prompt.meta.methodName as string,
      user,
      reqCtx,
    );
    const instance = (await this.resolveMember(prompt.ctor, reqCtx)) as Record<
      string,
      Function
    >;
    const result =
      await instance[prompt.meta.methodName as string].call(instance);
    return {
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result),
          },
        },
      ],
    };
  }

  /**
   * Validate input, weave in `@inject(...)` parameters, invoke the method,
   * validate output. Shared by callTool + SDK handler.
   *
   * Cross-cutting concerns that need to *compose* (tracing + metering + …)
   * should prefer dispatch hooks over subclassing: bind an
   * {@link McpDispatchHook} tagged {@link MCP_DISPATCH_HOOK_TAG} before
   * `app.start()`. Hooks wrap the whole body below — including principal
   * mapping and authorization, so denials surface to hooks as thrown
   * errors — with the first-bound hook outermost. A subclass override that
   * calls `super.dispatchTool` runs outside the hook chain, so both seams
   * work together.
   */
  // `protected` so subclasses can wrap tool dispatch (e.g. usage metering).
  protected async dispatchTool(
    tool: ToolBinding,
    input: unknown,
    ctx: Context = this.context,
  ): Promise<unknown> {
    // Per-request context guarantee: request-scoped state (principals, auth
    // info) must never be bound into the shared app context — that would leak
    // across requests. The SDK handler passes in a child it already created;
    // every other entry path (callTool, inspector, stdio) gets a fresh child
    // here.
    const reqCtx =
      ctx === this.context ? new Context(this.context, 'mcp.request') : ctx;
    const run = (): Promise<unknown> => this.invokeTool(tool, input, reqCtx);

    const hooks = await this.resolveDispatchHooks();
    if (hooks.length === 0) return run();

    const info: McpDispatchInfo = {tool, input, ctx: reqCtx};
    let next = run;
    for (let i = hooks.length - 1; i >= 0; i--) {
      const hook = hooks[i]!;
      const inner = next;
      next = () => hook(info, inner);
    }
    return next();
  }

  /**
   * Resolve the dispatch hooks bound under {@link MCP_DISPATCH_HOOK_TAG}.
   * The resolved list is cached after the first lookup (first tool call) —
   * hooks must be bound before `app.start()`.
   */
  private dispatchHookCache?: McpDispatchHook[];
  protected async resolveDispatchHooks(): Promise<McpDispatchHook[]> {
    if (!this.dispatchHookCache) {
      const hooks: McpDispatchHook[] = [];
      for (const binding of this.context.findByTag(MCP_DISPATCH_HOOK_TAG)) {
        hooks.push(await this.context.get<McpDispatchHook>(binding.key));
      }
      this.dispatchHookCache = hooks;
    }
    return this.dispatchHookCache;
  }

  /**
   * The core tool pipeline (extracted from `dispatchTool` so hooks can wrap
   * it): principal mapping → authorization → input validation → `@inject`
   * weaving → method invocation → output validation.
   */
  private async invokeTool(
    tool: ToolBinding,
    input: unknown,
    reqCtx: Context,
  ): Promise<unknown> {
    const user = await this.bindRequestPrincipals(reqCtx);

    // Authorization before input validation — same order as REST dispatch, so
    // unauthorized callers learn nothing about a tool's schema.
    await this.authorizeTool(tool, user, reqCtx);

    // Safety gate: `confirm:` tools require a confirmation round-trip. The
    // token rides in the optional `confirmationToken` input property
    // (advertised in the inputSchema) and is stripped before validation.
    if (tool.meta.confirm) {
      input = await this.enforceConfirmation(tool, input);
    }

    const nonInjected: unknown[] = [];
    if (tool.meta.input) {
      const parsedIn = standardParse(tool.meta.input, input);
      if (!parsedIn.success) {
        throw issuesError(
          `Invalid input for tool ${tool.meta.name}`,
          parsedIn.issues,
          'input',
          {code: ErrorCodes.INVALID_INPUT, schema: tool.meta.input},
        );
      }
      nonInjected.push(parsedIn.data);
    }

    // Resolve method-parameter `@inject(...)` against the per-request child
    // context so handlers can inject `MCPBindings.REQUEST_AUTH`,
    // `SecurityBindings.USER` and other request-scoped values.
    const args = await resolveInjectedArguments(
      tool.ctor.prototype,
      tool.meta.methodName as string,
      reqCtx,
      undefined,
      nonInjected,
    );
    const instance = (await this.resolveMember(tool.ctor, reqCtx)) as Record<
      string,
      Function
    >;
    let result = await instance[tool.meta.methodName as string].apply(
      instance,
      args,
    );

    // Stream-tools bridge: a method returning an async iterable (e.g. an async
    // generator that is also a `@get(..., {streamOf: X})` SSE route) is drained
    // here. Each yielded item is relayed as a progress notification via the
    // per-request `MCPBindings.PROGRESS` fn (no-op when the caller sent no
    // progressToken), and the collected items become the tool result — so a
    // streamOf generator "streams" over MCP with no new metadata. Strings and
    // arrays are NOT async-iterable, so this detection is unambiguous. For such
    // a tool, `output:` describes the COLLECTED shape (typically
    // `z.array(ItemSchema)`); output validation below then applies to the array.
    if (
      result != null &&
      typeof (result as {[Symbol.asyncIterator]?: unknown})[
        Symbol.asyncIterator
      ] === 'function'
    ) {
      const progress =
        (await reqCtx.get(MCPBindings.PROGRESS, {optional: true})) ??
        noopProgress;
      const iterator = (result as AsyncIterable<unknown>)[
        Symbol.asyncIterator
      ]();
      const collected: unknown[] = [];
      try {
        for (let i = 0; ; i++) {
          const step = await iterator.next();
          if (step.done) break;
          collected.push(step.value);
          // `total` is unknown for a generator — the ProgressFn type leaves it
          // optional, so omit it. `message` is a short JSON preview of the item.
          await progress({
            progress: i + 1,
            message: JSON.stringify(step.value),
          });
        }
      } finally {
        // Run the generator's own cleanup (its `finally` block) even if a later
        // step throws — `return()` resumes the generator at its suspension point
        // so `try/finally` inside the method runs.
        await iterator.return?.();
      }
      result = collected;
    }

    if (!tool.meta.output) return result;
    const parsedOut = standardParse(tool.meta.output, result);
    if (!parsedOut.success) {
      throw issuesError(
        `Invalid output from tool ${tool.meta.name}`,
        parsedOut.issues,
        'output',
        {code: ErrorCodes.INVALID_OUTPUT},
      );
    }
    return parsedOut.data;
  }

  /**
   * `confirm:` tools: the first call (no `confirmationToken` input property)
   * fails with `confirmation_required` carrying a single-use token bound to
   * the exact input; the identical retry with the token executes. Returns
   * the input with the token stripped, ready for schema validation.
   */
  protected async enforceConfirmation(
    tool: ToolBinding,
    input: unknown,
  ): Promise<unknown> {
    const raw =
      input && typeof input === 'object'
        ? {...(input as Record<string, unknown>)}
        : {};
    const token = raw.confirmationToken;
    delete raw.confirmationToken;
    const scope = `tool:${tool.meta.name}`;
    const fingerprint = stableStringify(raw);
    const store = await this.confirmationStore();
    if (typeof token !== 'string' || !token) {
      const ttlMs =
        typeof tool.meta.confirm === 'object'
          ? tool.meta.confirm.ttlMs
          : undefined;
      const issued = store.issue(scope, fingerprint, ttlMs);
      const err = new Error(
        `Tool ${tool.meta.name} requires confirmation. Retry the identical ` +
          `call with the issued token in the 'confirmationToken' input ` +
          `property.`,
      );
      const e = err as Error & {
        code: string;
        confirmationToken: string;
        publicMessage: string;
      };
      e.code = ErrorCodes.CONFIRMATION_REQUIRED;
      e.confirmationToken = issued;
      e.publicMessage = err.message;
      throw err;
    }
    if (!store.verify(token, scope, fingerprint)) {
      const err = new Error(
        'The confirmation token is invalid, expired, or was issued for a ' +
          'different input.',
      );
      const e = err as Error & {code: string; publicMessage: string};
      e.code = ErrorCodes.CONFIRMATION_INVALID;
      e.publicMessage = err.message;
      throw err;
    }
    return raw;
  }

  private confirmationStoreCache?: ConfirmationStore;
  protected async confirmationStore(): Promise<ConfirmationStore> {
    if (!this.confirmationStoreCache) {
      this.confirmationStoreCache =
        (await this.context.get(MCPBindings.CONFIRMATION_STORE, {
          optional: true,
        })) ?? new InMemoryConfirmationStore();
    }
    return this.confirmationStoreCache;
  }

  /**
   * Collect every `@tool`/`@resource`/`@prompt` method across all `@mcpServer`
   * contributors for one metadata key. `this.context.find(...)` is a chain walk,
   * so a per-session/per-request child context sees both its own tools and the
   * shared app-level ones. Stays on `@inject.context()` (not `@extensions.view`)
   * because `this.context` also builds per-request children, discovers dispatch
   * hooks, and resolves the confirmation store — the view would only cover this
   * one slice while adding a per-session subscription.
   */
  private collectMembers<M extends object>(
    key: MetadataAccessor<M, MethodDecorator>,
  ): {ctor: Function; meta: M & {methodName: string}}[] {
    const out: {ctor: Function; meta: M & {methodName: string}}[] = [];
    for (const b of this.context.find(extensionFilter(MCP_SERVERS))) {
      const ctor = b.valueConstructor;
      if (typeof ctor !== 'function') continue;
      const members =
        MetadataInspector.getAllMethodMetadata<M>(key, ctor.prototype) ?? {};
      for (const [methodName, meta] of Object.entries(members)) {
        if (!meta) continue;
        out.push({ctor, meta: {...meta, methodName}});
      }
    }
    return out;
  }

  private collectAllTools(): ToolBinding[] {
    return this.collectMembers<ToolMetadata>(MCPKeys.TOOL);
  }

  private collectAllResources(): {ctor: Function; meta: ResourceMetadata}[] {
    return this.collectMembers<ResourceMetadata>(MCPKeys.RESOURCE);
  }

  private collectAllPrompts(): {ctor: Function; meta: PromptMetadata}[] {
    return this.collectMembers<PromptMetadata>(MCPKeys.PROMPT);
  }

  /**
   * Resolve a tool/resource/prompt class instance. The class is discovered by
   * its `@mcpServer` tag, so resolve it through that **same binding** — whatever
   * namespace it lives in (`services.*`, `controllers.*`, or a manual
   * `bind().tag(mcpServer)`). This runs constructor `@inject` and honors the
   * binding's scope; the registration verb (`app.service`/`app.controller`/…) is
   * irrelevant. `findByTag` walks the context chain, so a per-request child
   * still finds app-level tool bindings, and `ctx.get` resolves request-scoped
   * constructor injects against that child.
   */
  private async resolveMember<T = object>(
    ctor: Function,
    ctx: Context = this.context,
  ): Promise<T> {
    const binding = ctx
      .find(extensionFilter(MCP_SERVERS))
      .find(b => b.valueConstructor === ctor);
    if (binding) return ctx.get<T>(binding.key);
    // Safety net: a discovered tool always has a tagged binding, so this is only
    // reached for a class invoked without one — instantiate with no DI.
    return new (ctor as new () => T)();
  }

  /**
   * Surface the migration-visible case where a tool is gated by a CLASS-level
   * `@authorize` (written with REST in mind) rather than its own method-level
   * one — the "one declaration" semantic makes that gating apply to MCP too.
   */
  private warnOnClassLevelGating(t: ToolBinding) {
    if (this.warnedClassGated.has(t.meta.name)) return;
    const methodMeta =
      MetadataInspector.getAllMethodMetadata<AuthorizationMetadata>(
        AuthorizationKeys.METADATA,
        t.ctor.prototype,
      )?.[t.meta.methodName as string];
    const classMeta = MetadataInspector.getClassMetadata<AuthorizationMetadata>(
      AuthorizationKeys.CLASS_METADATA,
      t.ctor,
    );
    if (!methodMeta && classMeta && !classMeta.skip) {
      this.warnedClassGated.add(t.meta.name);
      log.info(
        'tool %s is gated by class-level @authorize on %s',
        t.meta.name,
        t.ctor.name,
      );
    }
  }

  /**
   * Run the `@authorize` voter chain for a tool method — the same metadata,
   * resolver, and chain REST dispatch uses, so one declaration governs both
   * surfaces. No metadata (or `@authorize.skip`) → allowed, today's behavior.
   */
  protected async authorizeTool(
    tool: ToolBinding,
    user: UserProfile | undefined,
    reqCtx: Context,
  ): Promise<void> {
    return this.authorizeMember(
      tool.ctor,
      tool.meta.methodName as string,
      user,
      reqCtx,
    );
  }

  /**
   * Run the `@authorize` voter chain for any class member — tools,
   * resources, and prompts share one policy pipeline. No metadata (or
   * `@authorize.skip`) → allowed.
   */
  protected async authorizeMember(
    ctor: Function,
    methodName: string,
    user: UserProfile | undefined,
    reqCtx: Context,
  ): Promise<void> {
    const meta = getAuthorizationMetadata(ctor, methodName);
    if (!meta || meta.skip) return;
    const authCtx = buildAuthorizationContext(
      user,
      `${ctor.name}.${methodName}`,
    );
    const decision = await runAuthorization(authCtx, meta, reqCtx);
    if (decision !== AuthorizationDecision.ALLOW) {
      const err = new Error(
        `Forbidden: not authorized for ${authCtx.resource}.`,
      );
      const e = err as Error & {code: string; publicMessage: string};
      e.code = ErrorCodes.FORBIDDEN;
      e.publicMessage = err.message;
      throw err;
    }
  }

  /**
   * Map transport auth (`MCPBindings.REQUEST_AUTH`, deposited by the HTTP
   * layer) onto framework principals and bind them into the per-request
   * context — falling back to the configured `localPrincipal` ambient
   * identity for unauthenticated transports. Shared by tools, resources,
   * and prompts.
   */
  protected async bindRequestPrincipals(
    reqCtx: Context,
  ): Promise<UserProfile | undefined> {
    const authInfo = await reqCtx.get(MCPBindings.REQUEST_AUTH, {
      optional: true,
    });
    const {user, clientApplication} = authInfo
      ? authInfoToPrincipals(authInfo)
      : {user: this.config.localPrincipal, clientApplication: undefined};
    if (user) reqCtx.bind(SecurityBindings.USER).to(user);
    if (clientApplication) {
      reqCtx.bind(SecurityBindings.CLIENT_APPLICATION).to(clientApplication);
    }
    return user;
  }

  /**
   * Build the per-request child context for an SDK handler invocation,
   * binding the transport extras (auth, request info, raw extras, progress
   * relay). Shared by the tool/resource/prompt registration closures.
   */
  protected requestContextFor(extra: ToolRequestExtra): Context {
    const ctx = new Context(this.context, 'mcp.request');
    if (extra.authInfo) {
      ctx.bind(MCPBindings.REQUEST_AUTH).to(extra.authInfo);
    }
    if (extra.requestInfo) {
      ctx.bind(MCPBindings.REQUEST_INFO).to(extra.requestInfo);
    }
    ctx.bind(MCPBindings.REQUEST_EXTRA).to(extra);
    ctx.bind(MCPBindings.PROGRESS).to(progressFnFor(extra));
    return ctx;
  }

  /**
   * Build a fresh underlying `McpServer` with every discovered
   * tool/resource/prompt registered. Used to back a per-session Streamable HTTP
   * transport: a single `McpServer` can only be connected to one live transport
   * at a time, so concurrent HTTP sessions each get their own server instance
   * (all exposing the same surface). See `@agentback/mcp-http`.
   */
  buildServer(options: {scopes?: string[]} = {}): McpServer {
    const server = new McpServer(
      {name: this.config.name, version: this.config.version},
      {capabilities: {tools: {}, resources: {}, prompts: {}}},
    );
    this.registerAllOn(server, options.scopes);
    return server;
  }

  /**
   * Register discovered tools/resources/prompts onto an MCP SDK server. When
   * `scopes` is provided (an authenticated transport), a tool declaring a
   * `scope` is only registered if that scope is present — so `tools/list` and
   * `tools/call` are gated by construction. When `scopes` is undefined (stdio /
   * unauthenticated), every tool is registered.
   */
  private registerAllOn(target: McpServer, scopes?: string[]) {
    // Tools register through the SDK's LOW-LEVEL request handlers (the
    // `Server` underneath the high-level `McpServer`): the high-level
    // `registerTool` consumes a `ZodRawShape`, which would lock tool schemas
    // to Zod. Declaring tools as emitted JSON Schema and validating
    // input/output framework-side (`standardParse` in `dispatchTool`)
    // supports any Standard Schema vendor. Resources/prompts keep the
    // high-level registration below.
    interface ToolListEntry {
      name: string;
      title?: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }
    const visible = new Map<
      string,
      {tool: ToolBinding; entry: ToolListEntry}
    >();
    for (const t of this.collectAllTools()) {
      // Visibility: scopes from `@authorize({scopes})` (or the legacy
      // `@tool(..., {scope})`) gate registration on authenticated transports.
      // Roles/voter-gated tools stay visible and are denied at call time.
      const required = requiredScopesForTool(t.ctor, t.meta);
      if (
        scopes &&
        required.length &&
        !required.every(s => scopes.includes(s))
      ) {
        log.debug(
          'skipping tool %s (requires scopes %j)',
          t.meta.name,
          required,
        );
        continue;
      }
      this.warnOnClassLevelGating(t);
      // JSON Schema emission happens EAGERLY so a schema that can validate
      // but not describe itself (no native emission, no registered
      // converter) fails at registration time (`app.start()` /
      // `buildServer`), not at `tools/list`.
      const inputSchema = t.meta.input
        ? (schemaToOpenApiSchema(t.meta.input) as Record<string, unknown>)
        : {type: 'object'};
      // MCP requires inputSchema to be an object with named properties at the
      // root. A union/intersection/primitive lowers to anyOf/oneOf/allOf or a
      // scalar `type` — which has no `properties`, breaks tools/list, and would
      // be corrupted further by the confirmation-token injection below. Reject
      // it loudly at registration rather than emit a malformed schema. Note a
      // `.refine()` on a z.object() is fine (it lowers to the object schema),
      // but the refinement itself is validated at runtime only — it is NOT
      // reflected in the published inputSchema.
      if (t.meta.input && inputSchema.type !== 'object') {
        throw new Error(
          `MCP tool '${t.meta.name}': input schema must be an object ` +
            `(z.object(...)), but it lowered to ${describeNonObjectRoot(
              inputSchema,
            )}. MCP tool inputs need named properties at the root — a ` +
            `top-level union/intersection/primitive can't be expressed. ` +
            `Use a single z.object(); for cross-field rules add .refine() ` +
            `(validated at runtime, but not reflected in inputSchema).`,
        );
      }
      if (t.meta.confirm) {
        // Advertise the confirmation flow in the inputSchema so callers
        // discover it from tools/list, not from the first error.
        inputSchema.properties = {
          ...((inputSchema.properties as object | undefined) ?? {}),
          confirmationToken: {
            type: 'string',
            description:
              'This tool requires confirmation. Call once without this ' +
              'property to receive a single-use token in a ' +
              "'confirmation_required' error, then retry the identical " +
              'call with the token here.',
          },
        };
      }
      const outputSchema = t.meta.output
        ? (schemaToOpenApiSchema(t.meta.output) as Record<string, unknown>)
        : undefined;
      log.debug(
        'registering tool %s%s%s',
        t.meta.name,
        t.meta.input
          ? ` with input keys ${JSON.stringify(
              Object.keys((inputSchema.properties as object | undefined) ?? {}),
            )}`
          : ' (no input)',
        outputSchema
          ? ` output keys ${JSON.stringify(
              Object.keys(
                (outputSchema.properties as object | undefined) ?? {},
              ),
            )}`
          : '',
      );
      visible.set(t.meta.name, {
        tool: t,
        entry: {
          name: t.meta.name,
          ...(t.meta.title !== undefined ? {title: t.meta.title} : {}),
          ...(t.meta.description !== undefined
            ? {description: t.meta.description}
            : {}),
          inputSchema,
          ...(outputSchema ? {outputSchema} : {}),
          // MCP Apps (SEP-1865): link the tool to its ui:// widget so a
          // conformant host renders the resource for this tool's results.
          ...(t.meta.ui
            ? {
                _meta: {
                  ui: {
                    resourceUri: t.meta.ui.resourceUri,
                    ...(t.meta.ui.visibility
                      ? {visibility: t.meta.ui.visibility}
                      : {}),
                  },
                },
              }
            : {}),
        },
      });
    }

    const server = target.server;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(visible.values(), v => v.entry),
    }));
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request, extra): Promise<CallToolResult> => {
        try {
          const found = visible.get(request.params.name);
          if (!found) {
            throw new McpError(
              ErrorCode.InvalidParams,
              `Tool ${request.params.name} not found`,
            );
          }
          const t = found.tool;
          const input = (request.params.arguments ?? {}) as Record<
            string,
            unknown
          >;
          // A per-request child context isolates request-scoped bindings
          // (auth, transport headers, principals) from the shared app
          // context. Always created — dispatchTool binds principals into it,
          // and a shared-context write would leak across requests.
          const ctx = this.requestContextFor(extra);

          const result = await this.dispatchTool(t, input, ctx);
          // Pre-shaped MCP content (escape hatch).
          if (
            result &&
            typeof result === 'object' &&
            'content' in (result as object)
          ) {
            return result as CallToolResult;
          }
          const text =
            typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2);
          // With an output schema set we additionally surface
          // structuredContent so MCP clients consume the typed payload.
          if (t.meta.output) {
            return {
              content: [{type: 'text' as const, text}],
              structuredContent: result as Record<string, unknown>,
            };
          }
          return {content: [{type: 'text' as const, text}]};
        } catch (error) {
          // Tool failures surface as `isError` results, not protocol errors
          // — the same contract the SDK's high-level handler implements. The
          // text is the same machine-actionable envelope REST emits (stable
          // `code`, `issues`, violated `schema`, `retryable`, `hint`), so an
          // agent self-corrects from either surface with one parser.
          const {statusCode: _statusCode, ...envelope} =
            buildErrorEnvelope(error);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({error: envelope}),
              },
            ],
            isError: true,
          };
        }
      },
    );

    for (const r of this.collectAllResources()) {
      // Visibility: `@authorize({scopes})` gates registration on
      // authenticated transports, exactly like tools. Roles/voter-gated
      // resources stay visible and are denied at read time.
      const required = requiredScopesForMember(
        r.ctor,
        r.meta.methodName as string,
      );
      if (
        scopes &&
        required.length &&
        !required.every(s => scopes.includes(s))
      ) {
        log.debug(
          'skipping resource %s (requires scopes %j)',
          r.meta.name,
          required,
        );
        continue;
      }
      log.debug('registering resource %s -> %s', r.meta.name, r.meta.uri);
      target.registerResource(
        r.meta.name,
        r.meta.uri,
        {
          description: r.meta.description,
          mimeType: r.meta.mimeType,
        },
        (_uri, extra) =>
          this.dispatchResource(r, this.requestContextFor(extra)),
      );
    }

    for (const p of this.collectAllPrompts()) {
      const required = requiredScopesForMember(
        p.ctor,
        p.meta.methodName as string,
      );
      if (
        scopes &&
        required.length &&
        !required.every(s => scopes.includes(s))
      ) {
        log.debug(
          'skipping prompt %s (requires scopes %j)',
          p.meta.name,
          required,
        );
        continue;
      }
      log.debug('registering prompt %s', p.meta.name);
      // `registerPrompt` has no zero-argument form: its generic always types
      // the callback as `(args, extra)`. We register WITHOUT `argsSchema`, so at
      // runtime the SDK invokes `cb(extra)` and does no `arguments` validation —
      // identical to the old `prompt()` overload (passing `argsSchema: {}` to
      // satisfy the type instead breaks no-arg calls: getPrompt sends no
      // arguments → "expected object, received undefined"). The one-arg callback
      // is cast to the param type; this only sheds the deprecation hint.
      target.registerPrompt(p.meta.name, {description: p.meta.description}, ((
        extra: ToolRequestExtra,
      ) =>
        this.dispatchPrompt(
          p,
          this.requestContextFor(extra),
        )) as unknown as Parameters<typeof target.registerPrompt>[2]);
    }
  }

  async start(): Promise<void> {
    this.registerAllOn(this.mcp);

    if (this.config.transports.stdio !== false) {
      this.stdioTransport = new StdioServerTransport();
      await this.mcp.connect(this.stdioTransport);
      log.debug('mcp stdio transport connected');
    }
    this._listening = true;
  }

  async stop(): Promise<void> {
    if (this.stdioTransport) {
      await this.mcp.close();
      this.stdioTransport = undefined;
    }
    this._listening = false;
  }
}

/**
 * Build the per-request {@link ProgressFn} for a tool invocation: when the
 * caller requested progress (sent `_meta.progressToken`), relay
 * `notifications/progress` via `extra.sendNotification` with that token;
 * otherwise return the shared no-op so tool code never branches.
 */
export function progressFnFor(
  extra: Pick<ToolRequestExtra, 'sendNotification' | '_meta'>,
): ProgressFn {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return noopProgress;
  return async p => {
    await extra.sendNotification({
      method: 'notifications/progress',
      params: {progressToken, ...p},
    });
  };
}

/** Describe a non-object JSON Schema root for the inputSchema guardrail. */
function describeNonObjectRoot(schema: Record<string, unknown>): string {
  if ('anyOf' in schema) return 'a union (anyOf)';
  if ('oneOf' in schema) return 'a union (oneOf)';
  if ('allOf' in schema) return 'an intersection (allOf)';
  if (typeof schema.type === 'string') return `a non-object \`${schema.type}\``;
  return 'a non-object schema';
}

function issuesError(
  prefix: string,
  issues: readonly ParseIssue[],
  fallbackPath: string,
  options: {code: string; schema?: SchemaLike} = {code: 'invalid_input'},
): Error {
  const first = issues[0];
  const path = first?.path?.length ? first.path.join('.') : fallbackPath;
  const err = new Error(`${prefix}: ${path}: ${first?.message ?? 'invalid'}`);
  const e = err as Error & {
    issues: unknown;
    code: string;
    publicMessage: string;
    schema?: unknown;
  };
  e.issues = issues;
  e.code = options.code;
  e.publicMessage = err.message;
  if (options.schema) {
    // Best-effort: a schema that validates but cannot describe itself
    // degrades to omitting the fragment (issues still carry expected/received).
    try {
      e.schema = schemaToOpenApiSchema(options.schema);
    } catch {
      // ignore
    }
  }
  return err;
}

// Re-export for downstream code that needs to look up Zod types.
export type {ZodType};
