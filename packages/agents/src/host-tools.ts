// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {Context} from '@agentback/context';
import type {UserProfile} from '@agentback/security';
import {
  MCPBindings,
  requiredScopesForTool,
  type MCPServer,
  type ToolBinding,
} from '@agentback/mcp';
import {z} from 'zod';
// Type-only — erased at compile time; the runtime module loads lazily in
// importAi() so `ai` stays an optional peer (an installAgent-only consumer
// without it never crashes at barrel load).
import type {ToolSet} from 'ai';
import type {AgentToolContext} from './port.js';

const log = loggers('agentback:agents:host-tools');

/** Provider tool-calling name constraint (OpenAI/Anthropic-compatible). */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Identity set of tool objects created by {@link toHostTools}. */
const projectedTools = new WeakSet<object>();

/** Whether a tool object came from {@link toHostTools} (turn wrapper uses this to key toolsContext). */
export function isProjectedTool(t: unknown): boolean {
  return typeof t === 'object' && t !== null && projectedTools.has(t);
}

/**
 * The generated per-tool `contextSchema` — every projected tool declares it,
 * so the turn wrapper can deliver `{principal, turnId, turnCtx}` per call via
 * `toolsContext`. Top-level `.optional()` keeps `toolsContext` an optional
 * argument on bare `generate()` calls (the no-wrapper quickstart path).
 */
export const AgentToolContextSchema = z
  .object({
    principal: z
      .custom<UserProfile>(v => typeof v === 'object' && v !== null)
      .optional(),
    turnId: z.string().optional(),
    turnCtx: z
      .custom<Context>(v => typeof v === 'object' && v !== null)
      .optional(),
  })
  .optional();

export interface HostToolsOptions {
  /** Only these tools are projected. Least privilege: the quickstart pattern. */
  include?: string[];
  /** Registered tools to leave out. */
  exclude?: string[];
  /**
   * Scope gate, mirroring `buildServer({scopes})` visibility semantics: when
   * set, a tool requiring scopes is projected only if every required scope is
   * present. Omit for the trusted in-process default (everything visible).
   */
  scopes?: string[];
}

/**
 * Validate + filter the registered tool bindings for projection. Throws at
 * projection time — never let a misconfiguration surface as "the model
 * ignores my tool":
 *
 * - duplicate tool names (ambiguous projection),
 * - include/exclude entries matching no visible tool,
 * - `confirm:` tools named in an include list (their confirmation
 *   round-trip does not survive projection — excluded from v1),
 * - surviving names that violate provider tool-calling constraints.
 */
export function filterTools(
  all: ToolBinding[],
  opts: HostToolsOptions = {},
): ToolBinding[] {
  const byName = new Map<string, ToolBinding>();
  const dupes = new Set<string>();
  for (const t of all) {
    if (byName.has(t.meta.name)) dupes.add(t.meta.name);
    else byName.set(t.meta.name, t);
  }
  if (dupes.size) {
    throw new Error(
      `toHostTools: duplicate tool name(s): ${[...dupes].join(', ')} — ` +
        `an ambiguous projection is a misconfiguration.`,
    );
  }

  // Scope gate first: include/exclude are validated against what a caller
  // holding these scopes could actually see.
  const visible = [...byName.values()].filter(t => {
    if (!opts.scopes) return true;
    const required = requiredScopesForTool(t.ctor, t.meta);
    return required.every(s => opts.scopes!.includes(s));
  });
  const visibleNames = new Set(visible.map(t => t.meta.name));

  const unmatched = [...(opts.include ?? []), ...(opts.exclude ?? [])].filter(
    n => !visibleNames.has(n),
  );
  if (unmatched.length) {
    throw new Error(
      `toHostTools: include/exclude name(s) match no ` +
        `${opts.scopes ? 'visible' : 'registered'} tool: ` +
        `${unmatched.join(', ')}. Available: ` +
        `${[...visibleNames].join(', ') || '(none)'}.`,
    );
  }

  for (const n of opts.include ?? []) {
    if (byName.get(n)!.meta.confirm) {
      throw new Error(
        `toHostTools: tool '${n}' is a confirm: tool — the confirmation ` +
          `round-trip does not survive projection, so confirm: tools are ` +
          `excluded from host-tool projection (see the approval-flows open ` +
          `question in docs/proposals/harness.md).`,
      );
    }
  }

  const out = visible.filter(
    t =>
      !t.meta.confirm &&
      (!opts.include || opts.include.includes(t.meta.name)) &&
      !(opts.exclude ?? []).includes(t.meta.name),
  );

  const badNames = out.filter(t => !TOOL_NAME_RE.test(t.meta.name));
  if (badNames.length) {
    throw new Error(
      `toHostTools: tool name(s) violate the provider tool-calling ` +
        `constraint ${TOOL_NAME_RE}: ` +
        `${badNames.map(t => `'${t.meta.name}'`).join(', ')}. Rename the ` +
        `@tool or exclude it from projection.`,
    );
  }
  return out;
}

type AiModule = typeof import('ai');

let aiModule: AiModule | undefined;
async function importAi(): Promise<AiModule> {
  if (aiModule) return aiModule;
  try {
    aiModule = await import('ai');
  } catch (err) {
    throw new Error(
      `@agentback/agents: toHostTools() needs the optional peer dependency ` +
        `'ai' (the Vercel AI SDK). Install it: pnpm add ai`,
      {cause: err},
    );
  }
  return aiModule;
}

/**
 * Project the app's registered `@tool` classes as AI SDK host-executed tools.
 * The same Zod schema that already serves validation, `z.infer`, OpenAPI, and
 * MCP `inputSchema` becomes the AI SDK `inputSchema` — one source of truth,
 * a sixth view.
 *
 * Every call routes through `MCPServer.callTool`, so the full dispatch
 * pipeline applies: Zod validation, principal binding, the `@authorize`
 * voter chain, metering dispatch hooks, output validation. `execute` returns
 * the unwrapped, output-validated method result — never an MCP envelope.
 * Works before `app.start()` (tool discovery is a container scan).
 */
export async function toHostTools(
  app: Context,
  opts: HostToolsOptions = {},
): Promise<ToolSet> {
  const ai = await importAi();
  const mcp = await app.get<MCPServer>(MCPBindings.SERVER.key);
  const tools: ToolSet = {};
  for (const t of filterTools(mcp.listTools(), opts)) {
    // `ai.tool()` is a pure identity function (typing sugar); constructing
    // the tool object directly sidesteps its overload inference, which the
    // dynamic-import + Standard Schema passthrough would otherwise poison.
    const projected = {
      description: t.meta.description,
      // The @tool's own Zod (or Standard Schema) object — passed through, so
      // the AI SDK derives the model-facing JSON Schema from the same source
      // of truth. Tools without an input schema accept an open object.
      inputSchema:
        t.meta.input ??
        ai.jsonSchema({type: 'object', additionalProperties: true}),
      contextSchema: AgentToolContextSchema,
      // Identity is PER-TURN: the wrapper delivers {principal, turnCtx} via
      // toolsContext; `binding: t` (captured at projection time — tool
      // registration is static after boot) skips the per-call container scan.
      execute: (input: unknown, options?: {context?: AgentToolContext}) => {
        const c = options?.context;
        if (log.debug.enabled) {
          log.debug(
            'host tool %s called (turn %s)',
            t.meta.name,
            c?.turnId ?? '-',
          );
        }
        return mcp.callTool(
          t.meta.name,
          (input ?? {}) as Record<string, unknown>,
          {principal: c?.principal, ctx: c?.turnCtx, binding: t},
        );
      },
    } as unknown as ToolSet[string];
    projectedTools.add(projected);
    tools[t.meta.name] = projected;
  }
  return tools;
}
