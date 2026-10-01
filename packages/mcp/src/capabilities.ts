// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {
  JSONObject,
  ServerCapabilities,
} from '@modelcontextprotocol/server';
import {Binding, BindingType, type Context} from '@agentback/context';
import {
  extensionFilter,
  extensionFor,
  revertOwned,
  type Installed,
} from '@agentback/core';
import {assertJson} from './fragments.js';
import {MCP_CAPABILITIES} from './keys.js';
import type {MCPServerConfig} from './types.js';

/**
 * Extension and experimental capabilities one source adds to what the server
 * advertises on `initialize` (2025 era) and `server/discover` (2026). The same
 * shape as {@link MCPServerConfig.capabilities}.
 */
export type McpCapabilityContribution = NonNullable<
  MCPServerConfig['capabilities']
>;

/** Keys an app may add to the advertised server capabilities. */
const EXTRA_CAPABILITY_KEYS = ['extensions', 'experimental'] as const;

/**
 * Validate one capability source: only `extensions`/`experimental`, each an
 * object of JSON entries. Runtime-checked, not only typed, so a JS caller
 * cannot override a framework-owned `tools`/`resources`/`prompts` capability.
 */
export function assertCapabilityContribution(
  value: unknown,
  source: string,
): asserts value is McpCapabilityContribution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object`);
  }
  for (const [key, entries] of Object.entries(value)) {
    if (!(EXTRA_CAPABILITY_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `${source}.${key} is not allowed — only 'extensions' and ` +
          `'experimental' may be added; tools/resources/prompts are ` +
          `framework-owned`,
      );
    }
    if (
      typeof entries !== 'object' ||
      entries === null ||
      Array.isArray(entries)
    ) {
      throw new Error(
        `${source}.${key} must be an object of extension entries`,
      );
    }
    assertJson(entries, `${source}.${key}`);
  }
}

/** Structural equality over JSON values (the only values a source may hold). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    k =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      jsonEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
  );
}

/**
 * The capabilities a server advertises: the framework-owned
 * `tools`/`resources`/`prompts`, the config's `extensions`/`experimental`,
 * and every {@link MCP_CAPABILITIES} contribution visible from `ctx`.
 *
 * Contributions must be **constant** (`.to()`) bindings: `buildServer` is
 * synchronous and runs per request under stateless HTTP, so they are read
 * with `getSync`. A provider, class or dynamic binding throws. The same entry
 * key from two sources throws, naming both, unless the values are
 * deep-equal — a conflict is a misconfiguration, never last-wins.
 */
export function resolveCapabilities(
  config: Pick<MCPServerConfig, 'capabilities'>,
  ctx?: Context,
): ServerCapabilities {
  const sources: {source: string; value: McpCapabilityContribution}[] = [];
  if (config.capabilities !== undefined) {
    assertCapabilityContribution(
      config.capabilities,
      'MCPServerConfig.capabilities',
    );
    sources.push({
      source: 'MCPServerConfig.capabilities',
      value: config.capabilities,
    });
  }
  for (const binding of ctx?.find(extensionFilter(MCP_CAPABILITIES)) ?? []) {
    const source = `capability contribution '${binding.key}'`;
    if (binding.type !== BindingType.CONSTANT) {
      throw new Error(
        `${source} must be a constant (.to()) binding — capabilities are ` +
          `read synchronously on every server build; got ${binding.type ?? 'an unset binding'}`,
      );
    }
    const value = ctx!.getSync<unknown>(binding.key);
    assertCapabilityContribution(value, source);
    sources.push({source, value});
  }

  const merged: Record<string, Record<string, JSONObject>> = {};
  const owners = new Map<string, string>();
  for (const {source, value} of sources) {
    for (const key of EXTRA_CAPABILITY_KEYS) {
      for (const [id, entry] of Object.entries(value[key] ?? {})) {
        const slot = (merged[key] ??= {});
        const owner = owners.get(`${key}/${id}`);
        if (owner !== undefined) {
          if (jsonEqual(slot[id], entry)) continue;
          throw new Error(
            `capabilities.${key}['${id}'] is declared differently by ` +
              `${owner} and ${source}`,
          );
        }
        owners.set(`${key}/${id}`, source);
        slot[id] = structuredClone(entry);
      }
    }
  }
  return {tools: {}, resources: {}, prompts: {}, ...merged};
}

/**
 * Advertise extension or experimental capabilities from code — the form an
 * installer (a settings helper, a host adapter) uses, where
 * {@link MCPServerConfig.capabilities} is the app's own static declaration.
 *
 * Binds a constant {@link MCP_CAPABILITIES} contribution on `ctx` (usually the
 * application). It is validated now, and conflicts with the config or another
 * contribution throw at the next server build — `app.start()` at the latest.
 * Stateless HTTP sees it on the next request; a connected stdio or session
 * client keeps what it negotiated.
 *
 * `uninstall()` retracts it identity-guarded: if something else has since
 * bound the same key, that binding is left alone.
 *
 * @example
 *   const installed = contributeCapabilities(app, {
 *     extensions: {'com.example/widgets': {version: '1'}},
 *   });
 *
 * @experimental Host extensions are still settling (phase 1b of
 * docs/proposals/host-extensions.md); the shape may change in a minor release.
 */
export function contributeCapabilities(
  ctx: Context,
  contribution: McpCapabilityContribution,
  options: {key?: string} = {},
): Installed {
  assertCapabilityContribution(contribution, 'contributeCapabilities');
  const ids = EXTRA_CAPABILITY_KEYS.flatMap(k =>
    Object.keys(contribution[k] ?? {}),
  );
  const key = options.key ?? `${MCP_CAPABILITIES}.${ids.join('+') || 'empty'}`;
  const binding = new Binding(key)
    .to(structuredClone(contribution))
    .apply(extensionFor(MCP_CAPABILITIES));
  const displaced = ctx.contains(key) ? ctx.getBinding(key) : undefined;
  ctx.add(binding);
  let done = false;
  return {
    uninstall: async () => {
      if (done) return;
      done = true;
      revertOwned(ctx, binding, displaced);
    },
  };
}
