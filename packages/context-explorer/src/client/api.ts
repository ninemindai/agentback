// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export interface TagEntry {
  name: string;
  value: string | boolean;
}
export interface RouteInfo {
  verb: string;
  path: string;
  status?: number;
}
export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
}
export interface BindingNode {
  key: string;
  context: string;
  scope: string;
  type?: string;
  source?: string;
  isLocked?: boolean;
  tags: TagEntry[];
  kinds: string[];
  dependsOn: string[];
  injectsTags?: string[];
  extensionPoint?: string;
  extensionFor?: string[];
  configurationFor?: string;
  fromComponent?: string;
  lifeCycleGroup?: string;
  routes?: RouteInfo[];
  tools?: ToolInfo[];
}
export interface ContextNode {
  name: string;
  parent?: string;
}
export interface ContextModel {
  app: {name?: string; version?: string};
  contexts: ContextNode[];
  bindings: BindingNode[];
}
export interface InspectTree {
  name?: string;
  bindings: Record<string, unknown>;
  parent?: InspectTree;
}

export interface ContextApi {
  fetchModel(): Promise<ContextModel>;
  fetchInspect(): Promise<InspectTree>;
}

export function makeApi(apiBase: string): ContextApi {
  const getJson = async <T>(path: string): Promise<T> => {
    const r = await fetch(apiBase + path);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return (await r.json()) as T;
  };
  return {
    fetchModel: () => getJson<ContextModel>('/model'),
    fetchInspect: () => getJson<InspectTree>('/inspect'),
  };
}
