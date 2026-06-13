// Copyright Ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

// Typed fetch wrappers for the schema-explorer JSON API. Built from an explicit
// `apiBase` so the panel works standalone (base from `window.__SCHEMA_EXPLORER__`)
// and inside the unified console (base passed as a prop).

export type SchemaSurface = 'rest' | 'mcp';

export interface SchemaUsage {
  surface: SchemaSurface;
  role: string;
  ref: string;
  surfaceId: string;
  controller: string;
  method: string;
}

export interface SchemaNodeOrigin {
  table?: string;
  kind?: string;
  note?: string;
}

export interface SchemaNode {
  id: string;
  name: string;
  bound: boolean;
  bindingKey?: string;
  origin?: SchemaNodeOrigin;
  jsonSchema?: unknown;
  fieldCount?: number;
  usages: SchemaUsage[];
}

export interface SchemaSurfaceNode {
  id: string;
  surface: SchemaSurface;
  ref: string;
  controller: string;
  method: string;
}

export interface SchemaEdge {
  from: string;
  to: string;
  role: string;
  surface: SchemaSurface;
}

export interface SchemaGraph {
  nodes: SchemaNode[];
  surfaces: SchemaSurfaceNode[];
  edges: SchemaEdge[];
}

/** The schema-explorer operations, bound to one API base. */
export interface SchemaApi {
  fetchSchemas(): Promise<SchemaNode[]>;
  fetchGraph(): Promise<SchemaGraph>;
}

export function makeApi(apiBase: string): SchemaApi {
  const getJson = async <T>(path: string): Promise<T> => {
    const r = await fetch(apiBase + path);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    fetchSchemas: () => getJson<SchemaNode[]>('/schemas'),
    fetchGraph: () => getJson<SchemaGraph>('/graph'),
  };
}
