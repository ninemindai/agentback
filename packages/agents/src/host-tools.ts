// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {Context} from '@agentback/context';
import type {UserProfile} from '@agentback/security';
import {
  MCPBindings,
  selectTools,
  type MCPServer,
  type SelectToolsOptions,
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

export type HostToolsOptions = SelectToolsOptions;

/**
 * Filter the registered tool bindings for AI SDK projection. Delegates the
 * transport-neutral selection (dedup, scope gate, include/exclude validation,
 * `confirm:` exclusion) to `selectTools` in `@agentback/mcp` (shared with the
 * CLI projection — eng review T3), then applies the one AI-provider-specific
 * rule that does NOT belong in mcp core: the OpenAI/Anthropic tool-name regex.
 * Throws at projection time so a misconfiguration never surfaces as "the model
 * ignores my tool".
 */
export function filterTools(
  all: ToolBinding[],
  opts: HostToolsOptions = {},
): ToolBinding[] {
  const out = selectTools(all, opts);
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
