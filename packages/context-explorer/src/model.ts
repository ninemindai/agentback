// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {z} from 'zod';
import {
  CoreBindings,
  CoreTags,
  extensionFilter,
  type Context,
  type JSONObject,
} from '@agentback/core';
import {ContextTags} from '@agentback/context';
import {MetadataInspector} from '@agentback/metadata';
import {getControllerSpec} from '@agentback/openapi';
import {MCP_SERVERS, MCPKeys, type ToolMetadata} from '@agentback/mcp';

// ---- Schemas ----------------------------------------------------------------

export const TagEntry = z.object({
  name: z.string(),
  value: z.union([z.string(), z.boolean()]),
});

export const RouteInfo = z.object({
  verb: z.string(),
  path: z.string(),
  status: z.number().optional(),
});

export const ToolInfo = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
});

export const BindingNode = z.object({
  key: z.string(),
  context: z.string(),
  scope: z.string(),
  type: z.string().optional(),
  source: z.string().optional(),
  isLocked: z.boolean().optional(),
  tags: z.array(TagEntry),
  kinds: z.array(z.string()),
  dependsOn: z.array(z.string()),
  extensionPoint: z.string().optional(),
  extensionFor: z.array(z.string()).optional(),
  configurationFor: z.string().optional(),
  lifeCycleGroup: z.string().optional(),
  routes: z.array(RouteInfo).optional(),
  tools: z.array(ToolInfo).optional(),
});

export const ContextNode = z.object({
  name: z.string(),
  parent: z.string().optional(),
});

export const ContextModel = z.object({
  app: z.object({
    name: z.string().optional(),
    version: z.string().optional(),
  }),
  contexts: z.array(ContextNode),
  bindings: z.array(BindingNode),
});

export type ContextModel = z.infer<typeof ContextModel>;
export type BindingNode = z.infer<typeof BindingNode>;
export type ContextNode = z.infer<typeof ContextNode>;

// ---- Helpers ----------------------------------------------------------------

/**
 * Stringify a single tag value. Functions/classes (e.g. a constructor used as a
 * tag value) stringify to their whole source via `String()`, so collapse them
 * to just the name — a bare anonymous function falls back to `(anonymous)`.
 */
function tagValue(v: unknown): string | boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'function') return v.name || '(anonymous)';
  return String(v);
}

/** Normalize a `tagMap` into flat {name,value} entries; arrays fan out. */
function tagEntries(
  tagMap: Record<string, unknown>,
): z.infer<typeof TagEntry>[] {
  const out: z.infer<typeof TagEntry>[] = [];
  for (const [name, raw] of Object.entries(tagMap)) {
    if (Array.isArray(raw)) {
      for (const v of raw) out.push({name, value: tagValue(v)});
    } else {
      out.push({name, value: tagValue(raw)});
    }
  }
  return out;
}

/** Coerce a single string OR string[] tag value into string[]. */
function asArray(raw: unknown): string[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw.map(String);
  return [String(raw)];
}

// A binding address may carry a `#property` suffix; the key contains dots, so
// only strip the `#` suffix to recover the bound key.
const baseKey = (addr: string) => addr.split('#')[0]!;

/** Direct-key injection targets (constructor args + properties). */
function injectionKeys(b: JSONObject): string[] {
  const inj = b.injections as JSONObject | undefined;
  if (!inj) return [];
  const out: string[] = [];
  const ctor = (inj.constructorArguments as JSONObject[] | undefined) ?? [];
  for (const a of ctor) {
    if (typeof a?.bindingKey === 'string') out.push(baseKey(a.bindingKey));
  }
  const props =
    (inj.properties as Record<string, JSONObject> | undefined) ?? {};
  for (const p of Object.values(props)) {
    if (typeof p?.bindingKey === 'string') out.push(baseKey(p.bindingKey));
  }
  return out;
}

// ---- Build ------------------------------------------------------------------

/**
 * Build the consolidated explorer model from an application context.
 * Metadata-only: NEVER resolves a binding value, except the single permitted
 * `APPLICATION_METADATA` constant (a package.json object, never a secret).
 */
export function buildModel(ctx: Context): ContextModel {
  const inspectTree = ctx.inspect({
    includeInjections: true,
    includeParent: true,
  }) as JSONObject;

  // Sets of keys that are controllers / mcp servers (authoritative filters).
  const controllerKeys = new Set(
    ctx.findByTag(CoreTags.CONTROLLER).map(b => b.key),
  );
  const mcpKeys = new Set(
    ctx.find(extensionFilter(MCP_SERVERS)).map(b => b.key),
  );

  const contexts: z.infer<typeof ContextNode>[] = [];
  const bindings: BindingNode[] = [];
  const knownKeys = new Set<string>();

  // Pass 1: nodes + contexts across the parent chain.
  (function walk(node: JSONObject) {
    const ctxName = typeof node.name === 'string' ? node.name : '';
    const parentNode = node.parent as JSONObject | undefined;
    const parentName =
      parentNode && typeof parentNode.name === 'string'
        ? parentNode.name
        : undefined;
    contexts.push({name: ctxName, parent: parentName});

    const bmap = (node.bindings ?? {}) as Record<string, JSONObject>;
    for (const [key, b] of Object.entries(bmap)) {
      knownKeys.add(key);
      const tagMap = (b.tags as Record<string, unknown> | undefined) ?? {};
      const source =
        (b.valueConstructor as string | undefined) ??
        (b.providerConstructor as string | undefined) ??
        (b.alias as string | undefined);

      const kinds: string[] = [];
      if (controllerKeys.has(key)) kinds.push('controller');
      if (mcpKeys.has(key)) kinds.push('mcpServer');
      if (tagMap[CoreTags.COMPONENT] != null || key.startsWith('components.'))
        kinds.push('component');
      if (tagMap[CoreTags.LIFE_CYCLE_OBSERVER] != null)
        kinds.push('lifeCycleObserver');
      if (tagMap[CoreTags.EXTENSION_POINT] != null)
        kinds.push('extensionPoint');
      if (tagMap[CoreTags.EXTENSION_FOR] != null) kinds.push('extension');
      if (tagMap[ContextTags.CONFIGURATION_FOR] != null) kinds.push('config');
      if (key.startsWith('servers.')) kinds.push('server');

      const epRaw = tagMap[CoreTags.EXTENSION_POINT];
      const node: BindingNode = {
        key,
        context: ctxName,
        scope: String(b.scope ?? ''),
        type: b.type != null ? String(b.type) : undefined,
        source,
        isLocked: typeof b.isLocked === 'boolean' ? b.isLocked : undefined,
        tags: tagEntries(tagMap),
        kinds,
        dependsOn: [],
        extensionPoint: typeof epRaw === 'string' ? epRaw : undefined,
        extensionFor: asArray(tagMap[CoreTags.EXTENSION_FOR]),
        configurationFor:
          tagMap[ContextTags.CONFIGURATION_FOR] != null
            ? String(tagMap[ContextTags.CONFIGURATION_FOR])
            : undefined,
        lifeCycleGroup:
          tagMap[CoreTags.LIFE_CYCLE_OBSERVER_GROUP] != null
            ? String(tagMap[CoreTags.LIFE_CYCLE_OBSERVER_GROUP])
            : undefined,
      };
      bindings.push(node);
    }
    if (parentNode) walk(parentNode);
  })(inspectTree);

  // Pass 2: dependsOn edges (direct-key injections only; drop self/dangling).
  const byKey = new Map(bindings.map(n => [n.key, n]));
  (function link(node: JSONObject) {
    const bmap = (node.bindings ?? {}) as Record<string, JSONObject>;
    for (const [key, b] of Object.entries(bmap)) {
      const n = byKey.get(key);
      if (!n) continue;
      const seen = new Set<string>();
      for (const to of injectionKeys(b)) {
        if (to === key || !knownKeys.has(to) || seen.has(to)) continue;
        seen.add(to);
        n.dependsOn.push(to);
      }
    }
    if (node.parent) link(node.parent as JSONObject);
  })(inspectTree);

  // Pass 3: routes (controllers) — metadata only, no instantiation.
  for (const b of ctx.findByTag(CoreTags.CONTROLLER)) {
    const ctor = b.valueConstructor;
    const n = byKey.get(b.key);
    if (typeof ctor !== 'function' || !n) continue;
    let spec;
    try {
      spec = getControllerSpec(ctor);
    } catch {
      continue;
    }
    const routes: z.infer<typeof RouteInfo>[] = [];
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const verb of Object.keys(item as Record<string, unknown>)) {
        const full = joinPath(spec.basePath, path);
        routes.push({verb: verb.toUpperCase(), path: full});
      }
    }
    if (routes.length) n.routes = routes;
  }

  // Pass 4: tools (MCP servers) — metadata only.
  for (const b of ctx.find(extensionFilter(MCP_SERVERS))) {
    const ctor = b.valueConstructor;
    const n = byKey.get(b.key);
    if (typeof ctor !== 'function' || !n) continue;
    const tools =
      MetadataInspector.getAllMethodMetadata<ToolMetadata>(
        MCPKeys.TOOL,
        ctor.prototype,
      ) ?? {};
    const list: z.infer<typeof ToolInfo>[] = [];
    for (const meta of Object.values(tools)) {
      if (!meta) continue;
      list.push({
        name: meta.name,
        title: meta.title,
        description: meta.description,
      });
    }
    if (list.length) n.tools = list;
  }

  // App identity — the ONE permitted resolve (a plain constant; never secret).
  const app: ContextModel['app'] = {};
  try {
    const meta = ctx.getSync(CoreBindings.APPLICATION_METADATA, {
      optional: true,
    }) as {name?: string; version?: string} | undefined;
    if (meta) {
      app.name = meta.name;
      app.version = meta.version;
    }
  } catch {
    // No metadata bound — leave the identity card empty.
  }

  return {app, contexts, bindings};
}

/** Join a controller basePath with a route path into one mounted path. */
function joinPath(base: string | undefined, path: string): string {
  const a = (base ?? '').replace(/\/$/, '');
  const b = path.startsWith('/') ? path : '/' + path;
  return a + b || '/';
}
