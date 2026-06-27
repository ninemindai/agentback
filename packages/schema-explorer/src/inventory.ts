// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {CoreTags, extensionFilter, type Context} from '@agentback/core';
import {MetadataInspector} from '@agentback/metadata';
import {
  SCHEMA_TAG,
  SCHEMA_KEY_PREFIX,
  getControllerSpec,
  lookupRouteSchemas,
  schemaToOpenApiSchema,
  type RouteSchemas,
  type SchemaLike,
} from '@agentback/openapi';
import {MCP_SERVERS, MCPKeys, type ToolMetadata} from '@agentback/mcp';

/** Which boundary a schema is wired into. */
export type SchemaSurface = 'rest' | 'mcp';

/** The slot a schema fills on a route or tool. */
export type SchemaRole =
  | 'body'
  | 'path'
  | 'query'
  | 'headers'
  | 'response'
  | 'stream'
  | 'input'
  | 'output';

/** One place a schema is used: a route slot or a tool slot. */
export interface SchemaUsage {
  surface: SchemaSurface;
  role: SchemaRole;
  /** Human label of the consuming surface, e.g. `POST /users` or `create_user`. */
  ref: string;
  /** Stable id of the surface node (for graph edges). */
  surfaceId: string;
  /** Owning class name. */
  controller: string;
  /** Owning method name. */
  method: string;
}

/** Provenance copied from the schema's context binding tags, when registered. */
export interface SchemaNodeOrigin {
  table?: string;
  kind?: string;
  note?: string;
}

/** A domain schema (entity) and everywhere it is used across REST + MCP. */
export interface SchemaNode {
  id: string;
  /** Bound name (`bindSchema`) or a name synthesized from first usage. */
  name: string;
  /** Whether this node came from an explicit `schema`-tagged context binding. */
  bound: boolean;
  /** The context binding key, when bound. */
  bindingKey?: string;
  /** Origin tags (e.g. the Drizzle table), when bound with them. */
  origin?: SchemaNodeOrigin;
  /** Emitted JSON Schema for field display; absent if the schema can't emit. */
  jsonSchema?: unknown;
  /** Count of object properties, when derivable (list-view hint). */
  fieldCount?: number;
  usages: SchemaUsage[];
}

/** The "other end" of a usage edge: a route or tool that touches a schema. */
export interface SchemaSurfaceNode {
  id: string;
  surface: SchemaSurface;
  ref: string;
  controller: string;
  method: string;
}

/** schema → surface edge, role-labeled, for the provenance graph. */
export interface SchemaEdge {
  from: string; // schema node id
  to: string; // surface node id
  role: SchemaRole;
  surface: SchemaSurface;
}

export interface SchemaInventory {
  nodes: SchemaNode[];
  surfaces: SchemaSurfaceNode[];
  edges: SchemaEdge[];
}

/** Internal mutable node carrying the live schema object for identity joins. */
interface Building extends SchemaNode {
  schema: SchemaLike;
}

const REST_ROLES = [
  'body',
  'path',
  'query',
  'headers',
  'response',
] as const satisfies readonly (keyof RouteSchemas & SchemaRole)[];

/**
 * Invert the framework's registries into a schema-keyed index. Nodes come from
 * the DI container (every `schema`-tagged binding — names + origin), and edges
 * come from inverting the REST route registry and MCP tool metadata: each route
 * slot / tool slot is matched to its schema **by object reference identity**,
 * so the same `z.object(...)` shared by a route and a tool collapses to a single
 * node with two usages. Schemas never registered still appear — discovered from
 * the routes/tools that use them — with a synthesized name and no origin.
 *
 * Read-only and side-effect free; safe to call per request.
 */
export function buildSchemaInventory(ctx: Context): SchemaInventory {
  const byObject = new Map<SchemaLike, Building>();
  const surfaces = new Map<string, SchemaSurfaceNode>();
  let counter = 0;

  const node = (schema: SchemaLike): Building => {
    let n = byObject.get(schema);
    if (!n) {
      n = {id: `s${counter++}`, name: '', bound: false, usages: [], schema};
      byObject.set(schema, n);
    }
    return n;
  };

  const surface = (
    surfaceKind: SchemaSurface,
    ref: string,
    controller: string,
    method: string,
  ): SchemaSurfaceNode => {
    const id = `${surfaceKind}::${ref}`;
    let s = surfaces.get(id);
    if (!s) {
      s = {id, surface: surfaceKind, ref, controller, method};
      surfaces.set(id, s);
    }
    return s;
  };

  const addUsage = (
    schema: SchemaLike,
    surfaceKind: SchemaSurface,
    role: SchemaRole,
    ref: string,
    controller: string,
    method: string,
  ): void => {
    const n = node(schema);
    const s = surface(surfaceKind, ref, controller, method);
    // De-dupe identical usages (a schema reused in two slots of one route is
    // still two usages; the same slot recorded twice is not).
    if (
      n.usages.some(
        u =>
          u.surfaceId === s.id && u.role === role && u.surface === surfaceKind,
      )
    ) {
      return;
    }
    n.usages.push({
      surface: surfaceKind,
      role,
      ref,
      surfaceId: s.id,
      controller,
      method,
    });
  };

  // ---- Nodes: explicit `schema`-tagged context bindings ---------------------
  for (const b of ctx.findByTag(SCHEMA_TAG)) {
    let value: unknown;
    try {
      value = ctx.getSync(b.key);
    } catch {
      continue; // a schema binding that can't resolve synchronously — skip.
    }
    if (value == null || typeof value !== 'object') continue;
    const n = node(value as SchemaLike);
    n.bound = true;
    n.bindingKey = b.key;
    const tags = b.tagMap as Record<string, unknown>;
    const tagName = tags[SCHEMA_TAG];
    n.name =
      typeof tagName === 'string' && tagName.length
        ? tagName
        : b.key.startsWith(SCHEMA_KEY_PREFIX)
          ? b.key.slice(SCHEMA_KEY_PREFIX.length)
          : b.key;
    const origin: SchemaNodeOrigin = {};
    if (typeof tags.table === 'string') origin.table = tags.table;
    if (typeof tags.kind === 'string') origin.kind = tags.kind;
    if (typeof tags.note === 'string') origin.note = tags.note;
    if (Object.keys(origin).length) n.origin = origin;
  }

  // ---- Edges: invert REST route schemas -------------------------------------
  for (const b of ctx.findByTag(CoreTags.CONTROLLER)) {
    const ctor = b.valueConstructor;
    if (typeof ctor !== 'function') continue;
    let spec;
    try {
      spec = getControllerSpec(ctor);
    } catch {
      continue;
    }
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [verb, op] of Object.entries(
        item as Record<string, {operationId?: string}>,
      )) {
        const operationId = op?.operationId;
        if (!operationId) continue;
        const method = operationId.split('.').pop()!;
        const schemas = lookupRouteSchemas(ctor.prototype, method);
        if (!schemas) continue;
        // `spec.paths` keys are relative to the controller; basePath is stored
        // separately. Join them into the mounted path for a true route label.
        const ref = `${verb.toUpperCase()} ${joinPath(spec.basePath, path)}`;
        for (const role of REST_ROLES) {
          const schema = schemas[role];
          if (schema) addUsage(schema, 'rest', role, ref, ctor.name, method);
        }
        // SSE/JSONL streams declare their per-item shape as `streamOf`.
        if (schemas.streamOf) {
          addUsage(schemas.streamOf, 'rest', 'stream', ref, ctor.name, method);
        }
      }
    }
  }

  // ---- Edges: invert MCP tool schemas ---------------------------------------
  // No MCP servers bound (REST-only app) → this loop simply yields nothing.
  for (const b of ctx.find(extensionFilter(MCP_SERVERS))) {
    const ctor = b.valueConstructor;
    if (typeof ctor !== 'function') continue;
    const tools =
      MetadataInspector.getAllMethodMetadata<ToolMetadata>(
        MCPKeys.TOOL,
        ctor.prototype,
      ) ?? {};
    for (const [method, meta] of Object.entries(tools)) {
      if (!meta) continue;
      if (meta.input) {
        addUsage(meta.input, 'mcp', 'input', meta.name, ctor.name, method);
      }
      if (meta.output) {
        addUsage(meta.output, 'mcp', 'output', meta.name, ctor.name, method);
      }
    }
  }

  // ---- Finalize: names, JSON Schema, field counts ---------------------------
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  for (const n of byObject.values()) {
    if (!n.name) n.name = synthesizeName(n.usages);
    try {
      const json = schemaToOpenApiSchema(n.schema) as {
        properties?: Record<string, unknown>;
      };
      n.jsonSchema = json;
      if (json && typeof json === 'object' && json.properties) {
        n.fieldCount = Object.keys(json.properties).length;
      }
    } catch {
      // A schema that validates but cannot emit JSON Schema — leave undefined.
    }
    for (const u of n.usages) {
      edges.push({
        from: n.id,
        to: u.surfaceId,
        role: u.role,
        surface: u.surface,
      });
    }
    // Strip the live schema object before returning (not serializable / private).
    const {schema: _schema, ...pub} = n;
    void _schema;
    nodes.push(pub);
  }

  return {nodes, surfaces: [...surfaces.values()], edges};
}

/** Join a controller basePath with a route-relative path into the mounted URL. */
function joinPath(base: string | undefined, p: string): string {
  const b = (base ?? '').replace(/\/$/, '');
  const rel = p.startsWith('/') ? p : `/${p}`;
  const full = `${b}${rel}` || '/';
  return full.length > 1 ? full.replace(/\/$/, '') : full;
}

/** A readable name for an unregistered schema, derived from how it's used. */
function synthesizeName(usages: SchemaUsage[]): string {
  if (!usages.length) return 'anonymous';
  // Prefer a "produced" shape (response/output) — usually the entity itself.
  const produced = usages.find(
    u => u.role === 'response' || u.role === 'output',
  );
  const u = produced ?? usages[0]!;
  return `${u.ref} · ${u.role}`;
}
