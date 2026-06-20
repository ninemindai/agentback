// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import type {Context} from '@agentback/core';
import {buildModel} from '@agentback/context-explorer';
import {buildSchemaInventory} from '@agentback/schema-explorer';
import {AgentError, ErrorCodes} from '@agentback/openapi';

/** The node kinds the introspection surface exposes. */
export const IntrospectionKind = z.enum([
  'binding',
  'schema-entity',
  'route',
  'tool',
]);
export type IntrospectionKind = z.infer<typeof IntrospectionKind>;

/** A single inventory entry — the same `{kind,id}` shape the dock's focus chip
 * uses, so `get(focusChip)` is the natural drill-down. `label` is a display hint. */
export const IntrospectionNode = z.object({
  kind: IntrospectionKind,
  id: z.string(),
  label: z.string().optional(),
});
export type IntrospectionNode = z.infer<typeof IntrospectionNode>;

/**
 * Unified, read-only inventory of the live app's nodes. Bindings are
 * metadata-only (via context-explorer's `buildModel`, which never resolves a
 * value); routes/tools are flattened from the binding model; schema entities
 * come from the schema inventory. Deduped per (kind,id). Side-effect free
 * except that `buildSchemaInventory` resolves schema-tagged binding *values*
 * (their Zod object) for identity joins — schemas are not secrets.
 */
export function buildInventory(
  ctx: Context,
  kind?: IntrospectionKind,
): IntrospectionNode[] {
  const model = buildModel(ctx);
  const seen = new Set<string>();
  const nodes: IntrospectionNode[] = [];
  const push = (n: IntrospectionNode) => {
    const dedup = `${n.kind}:${n.id}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    nodes.push(n);
  };

  for (const b of model.bindings) {
    push({kind: 'binding', id: b.key, label: b.type});
    // buildModel uppercases the verb (context-explorer model.ts), so the id is
    // e.g. "GET /hello".
    for (const r of b.routes ?? []) {
      push({kind: 'route', id: `${r.verb} ${r.path}`, label: b.key});
    }
    for (const t of b.tools ?? []) {
      push({kind: 'tool', id: t.name, label: t.title});
    }
  }
  for (const n of buildSchemaInventory(ctx).nodes) {
    // Bound schemas get a stable id (their binding key). Unbound schemas fall
    // back to the per-call synthesized id (`s0`, `s1`, …) which is stable only
    // while the app's bindings are unchanged — resolve within one session.
    const id = n.bound && n.bindingKey ? n.bindingKey : n.id;
    push({kind: 'schema-entity', id, label: n.name || n.id});
  }

  return kind ? nodes.filter(n => n.kind === kind) : nodes;
}

function notFound(kind: IntrospectionKind, id: string): AgentError {
  return new AgentError(`No ${kind} found for id '${id}'.`, {
    status: 404,
    code: ErrorCodes.NOT_FOUND,
  });
}

/**
 * Fetch one node's detail by selector. Read-only: bindings return the
 * metadata-only `BindingNode` (never a resolved value); routes/tools return
 * their metadata plus the owning binding key; schema entities return the
 * `SchemaNode` (incl. emitted JSON Schema for field display).
 */
export function getNode(
  ctx: Context,
  selector: {kind: IntrospectionKind; id: string},
): unknown {
  const {kind, id} = selector;
  if (kind === 'binding') {
    const b = buildModel(ctx).bindings.find(x => x.key === id);
    if (!b) throw notFound(kind, id);
    return b;
  }
  if (kind === 'schema-entity') {
    // Match the stable binding key first (what inventory emits for bound
    // nodes), then the synthesized id (unbound nodes).
    const n = buildSchemaInventory(ctx).nodes.find(
      x => (x.bound && x.bindingKey === id) || x.id === id,
    );
    if (!n) throw notFound(kind, id);
    return n;
  }
  if (kind === 'route') {
    for (const b of buildModel(ctx).bindings) {
      const r = (b.routes ?? []).find(x => `${x.verb} ${x.path}` === id);
      if (r) return {...r, binding: b.key};
    }
    throw notFound(kind, id);
  }
  // kind === 'tool'
  for (const b of buildModel(ctx).bindings) {
    const t = (b.tools ?? []).find(x => x.name === id);
    if (t) return {...t, binding: b.key};
  }
  throw notFound(kind, id);
}
