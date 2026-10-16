// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describeInjectedArguments} from '@agentback/context';
import {MCPBindings} from './keys.js';
import {requiredScopesForTool} from './policy.js';
import type {ToolBinding} from './mcp.server.js';

/**
 * Whether the tool's method injects `MCPBindings.ELICIT`, i.e. may ask the
 * user something mid-call. Read from the method's `@inject` metadata, so it is
 * known at projection time without running the tool.
 */
export function toolAsksUser(t: ToolBinding): boolean {
  return describeInjectedArguments(
    t.ctor.prototype,
    String(t.meta.methodName),
  ).some(i => {
    const sel = i?.bindingSelector as unknown;
    return (
      sel === MCPBindings.ELICIT ||
      sel === MCPBindings.ELICIT.key ||
      String(sel) === MCPBindings.ELICIT.key
    );
  });
}

/**
 * Whether the tool is app-only: its MCP Apps (SEP-1865) `ui.visibility` is set
 * and omits `'model'`, so a host shows it to the app surface but not to the
 * model. An empty list omits `'model'` too. A tool with no `ui.visibility`
 * (host default) or with `'model'` in it is not app-only.
 */
function toolIsAppOnly(t: ToolBinding): boolean {
  const visibility = t.meta.ui?.visibility;
  return visibility !== undefined && !visibility.includes('model');
}

/**
 * Transport-neutral tool selection, shared by every projection that hands a
 * subset of the app's `@tool` classes to a caller — the AI SDK host-tools
 * (`@agentback/agents`) and the CLI (`@agentback/command`). Eng review T3 /
 * outside voice finding 5: the shared core lives here so both surfaces fail the
 * same way; the AI-provider tool-name regex is NOT part of it (that constraint
 * belongs to `@agentback/agents`, which wraps this).
 *
 * Throws at selection time — never let a misconfiguration surface later as "the
 * tool is silently missing":
 * - duplicate tool names (ambiguous selection),
 * - include/exclude entries matching no visible tool,
 * - `confirm:` tools named in an include list (their confirmation round-trip
 *   does not survive projection — excluded by default),
 * - tools that inject `MCPBindings.ELICIT` named in an include list (a
 *   projected caller has no user to ask — excluded by default),
 * - app-only tools (`ui.visibility` set without `'model'`) named in an include
 *   list. Both projections are model- or operator-facing, which is what an
 *   app-only tool opts out of, so they are excluded by default. The MCP
 *   `tools/list` path does not use this function and still lists them: an MCP
 *   Apps host filters by visibility itself.
 */
export interface SelectToolsOptions {
  /** Only these tools are selected (least privilege). */
  include?: string[];
  /** Registered tools to leave out. */
  exclude?: string[];
  /**
   * Scope gate, mirroring `buildServer({scopes})` visibility: when set, a tool
   * requiring scopes is selected only if every required scope is present.
   */
  scopes?: string[];
}

export function selectTools(
  all: ToolBinding[],
  opts: SelectToolsOptions = {},
): ToolBinding[] {
  const byName = new Map<string, ToolBinding>();
  const dupes = new Set<string>();
  for (const t of all) {
    if (byName.has(t.meta.name)) dupes.add(t.meta.name);
    else byName.set(t.meta.name, t);
  }
  if (dupes.size) {
    throw new Error(
      `selectTools: duplicate tool name(s): ${[...dupes].join(', ')} — ` +
        `an ambiguous selection is a misconfiguration.`,
    );
  }

  // Scope gate first: include/exclude validate against what a caller holding
  // these scopes could actually see.
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
      `selectTools: include/exclude name(s) match no ` +
        `${opts.scopes ? 'visible' : 'registered'} tool: ` +
        `${unmatched.join(', ')}. Available: ` +
        `${[...visibleNames].join(', ') || '(none)'}.`,
    );
  }

  for (const n of opts.include ?? []) {
    if (toolAsksUser(byName.get(n)!)) {
      throw new Error(
        `selectTools: tool '${n}' asks the user mid-call (it injects ` +
          `MCPBindings.ELICIT) — a projected caller has no user to ask, so ` +
          `such tools are excluded by default.`,
      );
    }
    if (toolIsAppOnly(byName.get(n)!)) {
      throw new Error(
        `selectTools: tool '${n}' is app-only (its ui.visibility omits ` +
          `'model') — app-only tools are excluded from model-facing ` +
          `projections. Add 'model' to its visibility or drop it from include.`,
      );
    }
    if (byName.get(n)!.meta.confirm) {
      throw new Error(
        `selectTools: tool '${n}' is a confirm: tool — the confirmation ` +
          `round-trip does not survive projection, so confirm: tools are ` +
          `excluded by default.`,
      );
    }
  }

  return visible.filter(
    t =>
      !t.meta.confirm &&
      !toolAsksUser(t) &&
      !toolIsAppOnly(t) &&
      (!opts.include || opts.include.includes(t.meta.name)) &&
      !(opts.exclude ?? []).includes(t.meta.name),
  );
}
