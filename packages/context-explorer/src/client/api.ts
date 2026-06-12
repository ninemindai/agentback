// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Typed fetch wrappers for the context-explorer JSON API. The API is built
// from an explicit `apiBase` (so the panel works both standalone and inside the
// unified console, which mounts it under a different base). Standalone, the
// base comes from `window.__CTX_EXPLORER__`; the console passes it as a prop.

export interface BindingSummary {
  key: string;
  context: string;
  scope: string;
  type?: string;
  source?: string;
  tags: string[];
  isLocked?: boolean;
}

export interface InspectTree {
  name?: string;
  bindings: Record<string, unknown>;
  parent?: InspectTree;
}

export interface GraphNode {
  key: string;
  scope: string;
  type?: string;
}

/** `from` depends on `to` (i.e. `from` injects the binding `to`). */
export interface GraphEdge {
  from: string;
  to: string;
}

export interface ContextGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** The context-explorer operations, bound to one API base. */
export interface ContextApi {
  fetchBindings(): Promise<BindingSummary[]>;
  fetchInspect(): Promise<InspectTree>;
  fetchGraph(): Promise<ContextGraph>;
}

export function makeApi(apiBase: string): ContextApi {
  const getJson = async <T>(path: string): Promise<T> => {
    const r = await fetch(apiBase + path);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    fetchBindings: () => getJson<BindingSummary[]>('/bindings'),
    fetchInspect: () => getJson<InspectTree>('/inspect'),
    fetchGraph: () => getJson<ContextGraph>('/graph'),
  };
}
