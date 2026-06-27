// Copyright NineMind, Inc. 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import type {Context} from '@agentback/core';
import {
  buildSchemaInventory,
  type SchemaInventory,
  type SchemaNode,
  type SchemaSurfaceNode,
} from './inventory.js';

/** One emitted Open Knowledge Format document. */
export interface OkfFile {
  path: string;
  content: string;
}

/** A derived OKF bundle: a set of markdown documents, sorted by path. */
export interface OkfBundle {
  files: OkfFile[];
}

export interface OkfOptions {
  /**
   * Surfaces to omit from the bundle (and any schema used _only_ by them).
   * Defaults to the framework's read-only dev-tooling controllers, so a bundle
   * describes the application — not the explorer that's serving it. Pass your
   * own predicate (or a no-op `() => false`) to override.
   */
  exclude?: (surface: SchemaSurfaceNode) => boolean;
}

/**
 * The framework's own introspection controllers. Their routes index the app
 * itself, so they're self-referential noise in a knowledge bundle about the
 * app's domain — excluded by default.
 */
const DEV_TOOLING_CONTROLLERS = new Set([
  'SchemaExplorerController',
  'ContextExplorerController',
  'McpInspectorController',
]);

function isDevTooling(surface: SchemaSurfaceNode): boolean {
  return DEV_TOOLING_CONTROLLERS.has(surface.controller);
}

/**
 * Serialize a {@link SchemaInventory} into an OKF
 * (https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
 * bundle: a portable, vendor-neutral directory of markdown + YAML-frontmatter
 * documents an agent can ingest verbatim.
 *
 * The bundle is **two-tier** and cross-linked:
 *  - `schemas/<slug>.md` — one doc per domain entity. `type: table` when the
 *    schema is backed by a Drizzle table (its `origin`), else `type: reference`.
 *  - `surfaces/<slug>.md` — one `reference` doc per REST route / MCP tool,
 *    linking back to the schemas it consumes.
 *  - auto `index.md` files (root + per tier) for progressive disclosure.
 *
 * Output is **derived and emit-only** — never read back to define behavior —
 * and **deterministic**: no timestamps, files sorted by path, so it diffs
 * cleanly in git. This is the same single source of truth the live
 * schema-explorer renders, serialized as files instead of a web UI.
 */
export function inventoryToOkf(
  inv: SchemaInventory,
  options: OkfOptions = {},
): OkfBundle {
  inv = applyExclude(inv, options.exclude ?? isDevTooling);

  // ---- Assign stable doc paths first (cross-links need both maps) ------------
  const used = new Set<string>();
  const claim = (dir: string, base: string, id: string): string => {
    let path = `${dir}/${base}.md`;
    if (used.has(path)) path = `${dir}/${base}-${slugify(id)}.md`;
    used.add(path);
    return path;
  };

  const nodes = [...inv.nodes].sort(byNameThenId);
  const surfaces = [...inv.surfaces].sort((a, b) => cmp(a.id, b.id));

  const schemaPath = new Map<string, string>(); // node id -> doc path
  for (const n of nodes) {
    schemaPath.set(n.id, claim('schemas', slugify(n.name), n.id));
  }
  const surfacePath = new Map<string, string>(); // surface id -> doc path
  for (const s of surfaces) {
    surfacePath.set(s.id, claim('surfaces', slugify(s.id), s.id));
  }

  // ---- Render the two tiers --------------------------------------------------
  const files: OkfFile[] = [];

  for (const n of nodes) {
    files.push({
      path: schemaPath.get(n.id)!,
      content: renderSchemaDoc(n, surfacePath),
    });
  }
  for (const s of surfaces) {
    files.push({
      path: surfacePath.get(s.id)!,
      content: renderSurfaceDoc(s, inv, nodes, schemaPath),
    });
  }

  // ---- Index files (progressive disclosure) ---------------------------------
  files.push({path: 'index.md', content: renderRootIndex(nodes, surfaces)});
  files.push({
    path: 'schemas/index.md',
    content: renderTierIndex('Schemas', nodes, n => ({
      label: n.name,
      href: `./${base(schemaPath.get(n.id)!)}`,
    })),
  });
  files.push({
    path: 'surfaces/index.md',
    content: renderTierIndex('Surfaces', surfaces, s => ({
      label: s.ref,
      href: `./${base(surfacePath.get(s.id)!)}`,
    })),
  });

  files.sort((a, b) => cmp(a.path, b.path));
  return {files};
}

/** Convenience: build the inventory from a DI context, then serialize it. */
export function buildOkfBundle(ctx: Context, options?: OkfOptions): OkfBundle {
  return inventoryToOkf(buildSchemaInventory(ctx), options);
}

/**
 * Drop excluded surfaces, the usages/edges that point at them, and any schema
 * left with no remaining usage that wasn't explicitly registered (`bound`) —
 * a registered schema is an intentional domain entity, so it stays even if
 * currently unexposed.
 */
function applyExclude(
  inv: SchemaInventory,
  exclude: (s: SchemaSurfaceNode) => boolean,
): SchemaInventory {
  const dropped = new Set(
    inv.surfaces.filter(exclude).map(s => s.id),
  );
  if (!dropped.size) return inv;

  const surfaces = inv.surfaces.filter(s => !dropped.has(s.id));
  const nodes = inv.nodes
    .map(n => ({...n, usages: n.usages.filter(u => !dropped.has(u.surfaceId))}))
    .filter(n => n.bound || n.usages.length > 0);
  const keptNodes = new Set(nodes.map(n => n.id));
  const keptSurfaces = new Set(surfaces.map(s => s.id));
  const edges = inv.edges.filter(
    e => keptNodes.has(e.from) && keptSurfaces.has(e.to),
  );
  return {nodes, surfaces, edges};
}

// ---- Renderers --------------------------------------------------------------

function renderSchemaDoc(
  n: SchemaNode,
  surfacePath: Map<string, string>,
): string {
  const tags = [...new Set(n.usages.map(u => u.surface))].sort();
  const fm = frontmatter({
    type: n.origin?.table ? 'table' : 'reference',
    tags,
  });

  const out: string[] = [fm, `# ${n.name}`, ''];

  if (n.origin?.table) {
    out.push(`Backed by Drizzle table \`${n.origin.table}\`.`, '');
  } else if (n.origin?.note) {
    out.push(n.origin.note, '');
  }

  const fields = renderFields(n.jsonSchema);
  if (fields) out.push(fields);

  if (n.usages.length) {
    out.push('## Used by', '');
    for (const u of [...n.usages].sort(byUsage)) {
      const href = `../${surfacePath.get(u.surfaceId) ?? ''}`;
      out.push(`- [${u.ref}](${href}) — ${u.surface} \`${u.role}\``);
    }
    out.push('');
  }

  return out.join('\n');
}

function renderSurfaceDoc(
  s: SchemaSurfaceNode,
  inv: SchemaInventory,
  nodes: SchemaNode[],
  schemaPath: Map<string, string>,
): string {
  const fm = frontmatter({type: 'reference', tags: [s.surface]});
  const out: string[] = [
    fm,
    `# ${s.ref}`,
    '',
    `\`${s.controller}.${s.method}\``,
    '',
  ];

  const byId = new Map(nodes.map(n => [n.id, n]));
  const incoming = inv.edges
    .filter(e => e.to === s.id)
    .sort((a, b) => cmp(a.role + a.from, b.role + b.from));

  if (incoming.length) {
    out.push('## Schemas', '');
    for (const e of incoming) {
      const n = byId.get(e.from);
      if (!n) continue;
      const href = `../${schemaPath.get(n.id) ?? ''}`;
      out.push(`- [${n.name}](${href}) — \`${e.role}\``);
    }
    out.push('');
  }

  return out.join('\n');
}

function renderRootIndex(
  nodes: SchemaNode[],
  surfaces: SchemaSurfaceNode[],
): string {
  const fm = frontmatter({type: 'index'});
  return [
    fm,
    '# Knowledge Bundle',
    '',
    'Derived from the application schema graph (REST + MCP + Drizzle).',
    '',
    `- [Schemas](./schemas/index.md) — ${nodes.length}`,
    `- [Surfaces](./surfaces/index.md) — ${surfaces.length}`,
    '',
  ].join('\n');
}

function renderTierIndex<T>(
  title: string,
  items: T[],
  link: (item: T) => {label: string; href: string},
): string {
  const fm = frontmatter({type: 'index'});
  const out = [fm, `# ${title}`, ''];
  for (const it of items) {
    const {label, href} = link(it);
    out.push(`- [${label}](${href})`);
  }
  out.push('');
  return out.join('\n');
}

// ---- Field table ------------------------------------------------------------

interface JsonFieldSchema {
  type?: unknown;
  format?: unknown;
  enum?: unknown[];
  $ref?: string;
}

interface JsonObjectSchema {
  properties?: Record<string, JsonFieldSchema>;
  required?: string[];
}

function renderFields(jsonSchema: unknown): string {
  const json = jsonSchema as JsonObjectSchema | undefined;
  const props = json?.properties;
  if (!props || !Object.keys(props).length) return '';
  const required = new Set(json?.required ?? []);
  const rows = Object.entries(props).map(
    ([fieldName, prop]) =>
      `| ${fieldName} | ${typeName(prop)} | ${required.has(fieldName) ? 'yes' : 'no'} |`,
  );
  return [
    '## Fields',
    '',
    '| Field | Type | Required |',
    '| --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

function typeName(prop: JsonFieldSchema): string {
  if (Array.isArray(prop.enum)) return prop.enum.map(String).join(' \\| ');
  if (typeof prop.$ref === 'string') return refName(prop.$ref);
  const t = prop.type;
  if (Array.isArray(t)) return t.map(String).join(' \\| ');
  if (typeof t === 'string') {
    return prop.format ? `${t} (${String(prop.format)})` : t;
  }
  // No `type`/`enum`/`$ref` (e.g. an unrepresentable schema lowered to `{}`):
  // the field accepts any value — say so rather than the misleading "unknown".
  return 'any';
}

/** The trailing name of a `$ref` pointer (`#/$defs/User` -> `User`). */
function refName(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1) || ref;
}

// ---- Helpers ----------------------------------------------------------------

/** Render a minimal, deterministic YAML frontmatter block (no timestamps). */
function frontmatter(meta: {type: string; tags?: string[]}): string {
  const lines = ['---', `type: ${meta.type}`];
  if (meta.tags && meta.tags.length) {
    lines.push(`tags: [${meta.tags.join(', ')}]`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'item'
  );
}

/** The filename of a path (`schemas/user.md` -> `user.md`). */
function base(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byNameThenId(a: SchemaNode, b: SchemaNode): number {
  return cmp(a.name, b.name) || cmp(a.id, b.id);
}

function byUsage(
  a: {surface: string; role: string; ref: string},
  b: {surface: string; role: string; ref: string},
): number {
  return cmp(a.surface + a.role + a.ref, b.surface + b.role + b.ref);
}
