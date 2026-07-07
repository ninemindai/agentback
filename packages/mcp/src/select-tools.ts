// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {requiredScopesForTool} from './policy.js';
import type {ToolBinding} from './mcp.server.js';

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
 *   does not survive projection — excluded by default).
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
      (!opts.include || opts.include.includes(t.meta.name)) &&
      !(opts.exclude ?? []).includes(t.meta.name),
  );
}
