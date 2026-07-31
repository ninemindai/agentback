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
      description: describeSchema(n),
    })),
  });
  files.push({
    path: 'surfaces/index.md',
    content: renderTierIndex('Surfaces', surfaces, s => ({
      label: s.ref,
      href: `./${base(surfacePath.get(s.id)!)}`,
      description: describeSurface(s),
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
  const dropped = new Set(inv.surfaces.filter(exclude).map(s => s.id));
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

/**
 * One-line `description` for a schema concept. Shared by the document's own
 * frontmatter and by the index entry that links to it, because OKF §8 says an
 * index entry SHOULD carry the linked concept's description — if these two
 * drifted, the bundle would contradict itself.
 */
export function describeSchema(n: SchemaNode): string {
  if (n.origin?.table) {
    return `Domain schema backed by Drizzle table \`${n.origin.table}\`, used by ${usagePhrase(n)}.`;
  }
  return `Domain schema used by ${usagePhrase(n)}.`;
}

/** One-line `description` for a surface concept. */
export function describeSurface(s: SchemaSurfaceNode): string {
  return `${s.surface.toUpperCase()} surface \`${s.ref}\`, served by ${s.controller}.${s.method}.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function usagePhrase(n: SchemaNode): string {
  const count = n.usages.length;
  if (count === 0) return 'no surface yet';
  const surfaces = [...new Set(n.usages.map(u => u.surface))]
    .sort()
    .join(' + ');
  return `${count} ${count === 1 ? 'surface' : 'surfaces'} (${surfaces})`;
}

function renderSchemaDoc(
  n: SchemaNode,
  surfacePath: Map<string, string>,
): string {
  const tags = [...new Set(n.usages.map(u => u.surface))].sort();
  const fm = frontmatter({
    type: n.origin?.table ? 'table' : 'reference',
    title: n.name,
    description: describeSchema(n),
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
  const fm = frontmatter({
    type: 'reference',
    title: s.ref,
    description: describeSurface(s),
    tags: [s.surface],
  });
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
  // OKF §8: index files carry NO frontmatter, with exactly one exception —
  // the bundle-root index MAY declare `okf_version` (§12). That is the only
  // key permitted here.
  return [
    '---',
    `okf_version: '${OKF_VERSION}'`,
    '---',
    '',
    '# Knowledge Bundle',
    '',
    'Derived from the application schema graph (REST + MCP + Drizzle).',
    '',
    `- [Schemas](./schemas/index.md) — ${plural(nodes.length, 'schema concept')}`,
    `- [Surfaces](./surfaces/index.md) — ${plural(surfaces.length, 'surface concept')}`,
    '',
  ].join('\n');
}

function renderTierIndex<T>(
  title: string,
  items: T[],
  link: (item: T) => {label: string; href: string; description: string},
): string {
  // No frontmatter: OKF §8 permits it only on the bundle-root index.
  const out = [`# ${title}`, ''];
  for (const it of items) {
    const {label, href, description} = link(it);
    // §8: entries SHOULD carry the linked concept's description.
    out.push(`- [${label}](${href}) — ${description}`);
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
/** OKF revision this emitter targets (declared on the bundle-root index). */
export const OKF_VERSION = '0.2';

/**
 * The actor recorded as this bundle's producer, per the OKF actor convention
 * (§7): `process:<id>` for an automated process. Deliberately NOT a `human:`
 * prefix — consumers key trust classification off that, and nothing here is
 * hand-authored.
 */
const GENERATED_BY = 'process:agentback-schema-explorer';

/**
 * Concept-document frontmatter (OKF v0.2 §4.1).
 *
 * `type` is the only REQUIRED key; `title` and `description` are recommended
 * and are what make an index useful to an agent, so they are always emitted.
 *
 * `generated.by` is emitted but `generated.at` deliberately is NOT: `at` is a
 * wall-clock timestamp and this emitter is contractually deterministic (the
 * same app must always produce the same bytes, so bundles diff cleanly and
 * tests can assert on them). `by` is the key the spec requires within
 * `generated`; `at` is optional, so omitting it stays conformant.
 */
function frontmatter(meta: {
  type: string;
  title: string;
  description: string;
  tags?: string[];
}): string {
  const lines = [
    '---',
    `type: ${meta.type}`,
    `title: ${yamlScalar(meta.title)}`,
    `description: ${yamlScalar(meta.description)}`,
  ];
  if (meta.tags && meta.tags.length) {
    lines.push(`tags: [${meta.tags.join(', ')}]`);
  }
  lines.push(`generated: {by: ${GENERATED_BY}}`, '---', '');
  return lines.join('\n');
}

/**
 * Quote a YAML scalar when it would otherwise change meaning. Schema and route
 * names carry `:`, `#`, `{`, quotes and leading indicators often enough that
 * emitting them bare would produce a document a consumer parses differently
 * than we wrote it.
 */
function yamlScalar(value: string): string {
  const v = value.replace(/\r?\n/g, ' ').trim();
  if (v === '') return "''";
  if (
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(v) ||
    /:\s|\s#/.test(v) ||
    /["']/.test(v)
  ) {
    return `'${v.replace(/'/g, "''")}'`;
  }
  return v;
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

/** One entry in an {@link OkfSummary}: enough to choose a file without reading it. */
export interface OkfFileSummary {
  path: string;
  /** Frontmatter `title`, or the document's first `#` heading for index files. */
  title: string;
  /** Frontmatter `description`. Empty for index files, which carry no frontmatter. */
  description: string;
  /** Concept `type`, absent on index files. */
  type?: string;
  /** Byte length of the document, so a consumer can budget before fetching. */
  bytes: number;
}

/**
 * A bundle's table of contents: paths, titles and descriptions, without the
 * bodies.
 *
 * The full bundle is a heavy payload for an agent to pull on every call —
 * progressive disclosure is what OKF's index files exist for (§8), and this is
 * the same idea in structured form. An agent reads the summary, picks the two
 * or three concepts it needs, and fetches only those.
 */
export interface OkfSummary {
  okfVersion: string;
  files: OkfFileSummary[];
  /** Total bytes of the full bundle, so a consumer can decide to just take it all. */
  totalBytes: number;
}

/**
 * Summarize a bundle by reading the frontmatter this emitter writes.
 *
 * Reads `title`/`description` from frontmatter rather than parsing the body,
 * which is exactly what those recommended fields are for — pulling a title out
 * of a `#` heading would be the bespoke translation OKF exists to eliminate.
 * Index files legitimately have no frontmatter (§8), so their title falls back
 * to the heading.
 */
export function summarizeOkfBundle(bundle: OkfBundle): OkfSummary {
  return {
    okfVersion: OKF_VERSION,
    totalBytes: bundle.files.reduce((n, f) => n + byteLength(f.content), 0),
    files: bundle.files.map(f => {
      const fm = parseFrontmatter(f.content);
      return {
        path: f.path,
        title: fm.title ?? headingOf(f.content) ?? f.path,
        description: fm.description ?? '',
        ...(fm.type ? {type: fm.type} : {}),
        bytes: byteLength(f.content),
      };
    }),
  };
}

/** Byte length, not character count — an agent's budget is bytes/tokens. */
function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Read the flat scalar keys of a frontmatter block. Deliberately not a YAML
 * parser: this reads back only what {@link frontmatter} wrote, and a bundle
 * whose frontmatter this cannot read is one this emitter did not produce.
 */
function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};
  const out: Record<string, string> = {};
  for (const line of content.slice(4, end).split('\n')) {
    const m = /^([a-z_]+): (.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = unquoteYamlScalar(m[2]);
  }
  return out;
}

function unquoteYamlScalar(v: string): string {
  const t = v.trim();
  return t.startsWith("'") && t.endsWith("'") && t.length >= 2
    ? t.slice(1, -1).replace(/''/g, "'")
    : t;
}

function headingOf(content: string): string | undefined {
  return /^# (.+)$/m.exec(content)?.[1];
}
