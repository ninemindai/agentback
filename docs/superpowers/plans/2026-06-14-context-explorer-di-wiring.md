# Context Explorer → DI Wiring Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `@agentback/context-explorer` from a flat 3-view binding browser into a DI **wiring** explorer that surfaces scopes/types, tag values, extension points, lifecycle observers, app/components, the context hierarchy, the config pattern, controller routes, and MCP tools — all from one consolidated `/model` endpoint feeding a three-pane facet UI.

**Architecture:** A single server-side `buildModel(ctx)` produces one JSON model (contexts + enriched binding nodes with `tags` values, `kinds`, `dependsOn`, and optional `routes`/`tools`), exposed at `GET /context-explorer/api/model`; the raw `/inspect` passthrough is kept for the Raw view. The React client derives every view (facets, detail wiring, graph, hierarchy) as pure selectors over that one model. The explorer **never resolves a binding's value** except the single constant `APPLICATION_METADATA`.

**Tech Stack:** TypeScript 6 (ESM, `.js` import suffixes), Zod 4, `@agentback/{core,context,openapi,rest,mcp,metadata}`, React 19 + `@xyflow/react` (React Flow) + `@dagrejs/dagre`, esbuild client bundle, Vitest (runs against built `dist/`).

**Spec:** `docs/superpowers/specs/2026-06-14-context-explorer-di-wiring-design.md`

---

## Conventions for every task

- **Build before test.** Vitest globs `packages/*/dist/__tests__/**`. After any `.ts` change run `pnpm -F @agentback/context-explorer build` (or have `pnpm build:watch` running) before `pnpm test`. Client changes need `pnpm -F @agentback/context-explorer build:client`.
- **Run a single test file:** `pnpm exec vitest run packages/context-explorer/dist/__tests__/integration/explorer.integration.js`
- **File header** (three lines) on every new source file:
  ```ts
  // Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
  // Node module: @agentback/context-explorer
  // This file is licensed under the MIT License.
  ```
- **Style:** single quotes, no bracket spacing (`{foo}`), trailing commas, 80 col. `pnpm -F @agentback/context-explorer lint:fix` before each commit.

---

## File Structure

**Server (`packages/context-explorer/src/`)**

- `model.ts` _(new)_ — Zod schemas (`ContextModel`, `BindingNode`, …) + `buildModel(ctx)`. The crux. One responsibility: turn a `Context` into the derived model, metadata-only.
- `index.ts` _(modify)_ — controller now serves `/model` (+ keeps `/inspect`), drops `/bindings` + `/graph`; imports schemas/builder from `model.ts`; `contextConsoleFeature()` unchanged in shape.

**Pure logic (`packages/context-explorer/src/lib/`) — tsc-compiled, NOT under `src/client`**

> IMPORTANT: `tsconfig.json` excludes `src/client` from the `tsc -b` program (the client tree is bundled by esbuild only). Vitest runs against `dist/`, so any module a unit test imports must be tsc-compiled. Therefore the pure selectors/hierarchy live in `src/lib/` (compiled to `dist/lib/`), NOT `src/client/lib/`. They `import type {BindingNode, ContextNode} from '../model.js'` (the tsc-compiled types) — a type-only import, which esbuild strips, so the browser bundle gains no `zod`/`@agentback/*` runtime dep. Client components import these modules with `../lib/...` / `../../lib/...` (esbuild resolves `src/lib` fine).

- `lib/selectors.ts` _(new)_ — pure functions over the model: `facets()`, `extensionGroups()`, `configEdges()`, `dualByCtor()`. Unit-tested.
- `lib/hierarchy.ts` _(new)_ — `buildContextTree(contexts, bindings)`. Unit-tested.
- The existing `client/lib/layout.ts` stays where it is (client-only, esbuild-bundled, no unit test).

**Client (`packages/context-explorer/src/client/`)**

- `api.ts` _(modify)_ — `fetchModel()` + model types; drop `fetchBindings`/`fetchGraph`.
- `App.tsx` _(modify)_ — three-pane facet shell + view switch (Explore/Graph/Hierarchy/Raw); owns state; selectors over the model.
- `components/FacetNav.tsx` _(new)_ — left facet nav.
- `components/ResultsList.tsx` _(new, replaces BindingList.tsx)_ — center list, color badges, tag chips.
- `components/BindingDetail.tsx` _(modify)_ — add Configures/Configured-by, extension wiring, Routes, Tools.
- `components/HierarchyView.tsx` _(new)_ — context tree view.
- `components/GraphView.tsx` _(modify)_ — consume model edges; color-by-scope.
- `console-page.tsx`, `main.tsx` _(unchanged)_ — already pass `apiBase` to `App`.

**Tests**

- `src/__tests__/integration/explorer.integration.ts` _(rewrite)_ — model shape, kinds, dual paths, no-resolve.
- `src/__tests__/unit/selectors.unit.ts` _(new)_ — selectors + hierarchy.
- `packages/console/src/__tests__/integration/console.integration.ts` _(modify)_ — repoint `/bindings` → `/model`.

---

# PHASE 0 — Enabler + model endpoint

## Task 1: Add `mcp` + `metadata` deps and wire project references

**Files:**

- Modify: `packages/context-explorer/package.json`
- Modify: `packages/context-explorer/tsconfig.json`

- [ ] **Step 1: Add dependencies**

In `packages/context-explorer/package.json`, add to `"dependencies"` (keep alphabetical-ish with the existing `@agentback/*` block):

```json
    "@agentback/console-theme": "workspace:~",
    "@agentback/core": "workspace:~",
    "@agentback/mcp": "workspace:~",
    "@agentback/metadata": "workspace:~",
    "@agentback/openapi": "workspace:~",
    "@agentback/rest": "workspace:~",
```

- [ ] **Step 2: Add project references**

In `packages/context-explorer/tsconfig.json`, add to the `references` array (match existing entries' relative-path style):

```json
    {"path": "../mcp"},
    {"path": "../metadata"}
```

- [ ] **Step 3: Install + verify it builds**

Run: `pnpm install && pnpm -F @agentback/context-explorer build`
Expected: install succeeds, build succeeds (no new errors).

- [ ] **Step 4: Commit**

```bash
git add packages/context-explorer/package.json packages/context-explorer/tsconfig.json pnpm-lock.yaml
git commit -m "build(context-explorer): add @agentback/mcp + metadata deps for model builder"
```

---

## Task 2: Model schemas + `buildModel` — write the failing integration test

**Files:**

- Modify (rewrite): `packages/context-explorer/src/__tests__/integration/explorer.integration.ts`

This task writes the new integration test FIRST (it will fail to compile/run until Tasks 3–4 land). We assert the full model contract here so the builder is built to it.

- [ ] **Step 1: Replace the test file** with the model-oriented suite

```ts
// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {
  BindingScope,
  CoreTags,
  config,
  extensionPoint,
  extensionFor,
  inject,
} from '@agentback/core';
import {api, get} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';
import {z} from 'zod';
import {RestApplication} from '@agentback/rest';
import {installContextExplorer} from '../../index.js';

const Greeting = z.object({msg: z.string()});

// A REST-only controller.
@api({basePath: '/things'})
class ThingsController {
  @get('/ping', {response: Greeting})
  async ping() {
    return {msg: 'pong'};
  }
}

// An MCP-only tool class.
@mcpServer()
class WeatherServer {
  @tool('forecast', {input: z.object({city: z.string()}), output: Greeting})
  async forecast() {
    return {msg: 'sunny'};
  }
}

// A dual REST+MCP class registered the SINGLE-binding way (restController()).
@api({basePath: '/dual'})
@mcpServer()
class DualOne {
  @get('/hi', {response: Greeting})
  async hi() {
    return {msg: 'hi'};
  }
  @tool('dualTool', {input: z.object({}), output: Greeting})
  async dualTool() {
    return {msg: 'tool'};
  }
}

// A dual REST+MCP class registered the TWO-binding way (controller + service).
@api({basePath: '/dual2'})
@mcpServer()
class DualTwo {
  @get('/yo', {response: Greeting})
  async yo() {
    return {msg: 'yo'};
  }
  @tool('dual2Tool', {input: z.object({}), output: Greeting})
  async dual2Tool() {
    return {msg: 'tool2'};
  }
}

// A provider that throws if instantiated — proves we never resolve.
class ExplodingProvider {
  constructor() {
    throw new Error('must never be resolved');
  }
  value() {
    return 'never';
  }
}

describe('context-explorer model', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeEach(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.setMetadata({name: 'test-app', version: '9.9.9', description: ''});

    app
      .bind('explorer.test.greeting')
      .to('hi')
      .tag('demo', 'greeting')
      .inScope(BindingScope.SINGLETON);
    app.bind('explorer.test.transient').to(42).inScope(BindingScope.TRANSIENT);

    // A secret + an exploding provider: must never be resolved.
    app.bind('secret.jwt').to('TOP-SECRET').inScope(BindingScope.SINGLETON);
    app.bind('danger.provider').toProvider(ExplodingProvider);

    // Config pattern: configure a (notional) server key.
    app.configure('servers.RestServer').to({port: 0});

    // Extension point + extension (single + multi point to hit array path).
    @extensionPoint('greeters')
    class GreeterPoint {}
    @extensionFor('greeters')
    class EnglishGreeter {}
    @extensionFor('greeters', 'salutations')
    class MultiGreeter {}
    app.service(GreeterPoint);
    app.service(EnglishGreeter);
    app.service(MultiGreeter);

    app.restController(ThingsController);
    app.service(WeatherServer);
    app.restController(DualOne); // single binding: REST + MCP
    app.controller(DualTwo); // two bindings...
    app.service(DualTwo); // ...same class

    await installContextExplorer(app, {title: 'Test Explorer'});
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterEach(async () => app.stop());

  const getModel = async () =>
    (await client.get('/context-explorer/api/model').expect(200)).body as {
      app: {name?: string; version?: string};
      contexts: {name: string; parent?: string}[];
      bindings: {
        key: string;
        scope: string;
        type?: string;
        tags: {name: string; value: string | boolean}[];
        kinds: string[];
        dependsOn: string[];
        extensionPoint?: string;
        extensionFor?: string[];
        configurationFor?: string;
        routes?: {verb: string; path: string}[];
        tools?: {name: string}[];
      }[];
    };

  const find = (m: Awaited<ReturnType<typeof getModel>>, key: string) =>
    m.bindings.find(b => b.key === key)!;

  it('returns scope, type and TAG VALUES (not just names)', async () => {
    const m = await getModel();
    const g = find(m, 'explorer.test.greeting');
    expect(g.scope).toBe(BindingScope.SINGLETON);
    expect(g.tags).toEqual(
      expect.arrayContaining([{name: 'demo', value: 'greeting'}]),
    );
    expect(find(m, 'explorer.test.transient').scope).toBe(
      BindingScope.TRANSIENT,
    );
  });

  it('reports the application identity from APPLICATION_METADATA', async () => {
    const m = await getModel();
    expect(m.app.name).toBe('test-app');
    expect(m.app.version).toBe('9.9.9');
  });

  it('exposes the context hierarchy', async () => {
    const m = await getModel();
    expect(m.contexts.length).toBeGreaterThan(0);
    expect(m.contexts.some(c => c.parent === undefined)).toBe(true);
  });

  it('computes dependsOn for direct-key injections', async () => {
    const m = await getModel();
    // The explorer controller injects the application instance.
    const ctrl = m.bindings.find(b =>
      b.dependsOn.includes('application.instance'),
    );
    expect(ctrl).toBeDefined();
  });

  it('detects controller and mcpServer kinds + extension wiring', async () => {
    const m = await getModel();
    expect(find(m, 'controllers.ThingsController').kinds).toContain(
      'controller',
    );
    // GreeterPoint is an extension point; EnglishGreeter extends it.
    const point = m.bindings.find(b => b.extensionPoint === 'greeters');
    expect(point).toBeDefined();
    const multi = m.bindings.find(
      b => b.extensionFor && b.extensionFor.includes('salutations'),
    )!;
    // Array extensionFor normalized to string[].
    expect(multi.extensionFor).toEqual(
      expect.arrayContaining(['greeters', 'salutations']),
    );
  });

  it('marks config bindings with configurationFor', async () => {
    const m = await getModel();
    const cfg = m.bindings.find(b => b.configurationFor != null);
    expect(cfg).toBeDefined();
    expect(cfg!.kinds).toContain('config');
  });

  it('dual via restController() is ONE node with both kinds, routes AND tools', async () => {
    const m = await getModel();
    const node = find(m, 'controllers.DualOne');
    expect(node.kinds).toEqual(
      expect.arrayContaining(['controller', 'mcpServer']),
    );
    expect(node.routes?.some(r => r.path.includes('/dual'))).toBe(true);
    expect(node.tools?.some(t => t.name === 'dualTool')).toBe(true);
  });

  it('dual via controller()+service() is TWO nodes sharing a source class', async () => {
    const m = await getModel();
    const dualTwoNodes = m.bindings.filter(
      b => (b as {source?: string}).source === 'DualTwo',
    );
    expect(dualTwoNodes.length).toBe(2);
    const kinds = new Set(dualTwoNodes.flatMap(b => b.kinds));
    expect(kinds.has('controller')).toBe(true);
    expect(kinds.has('mcpServer')).toBe(true);
  });

  it('never resolves a binding (secret + exploding provider untouched)', async () => {
    const m = await getModel();
    const serialized = JSON.stringify(m);
    expect(serialized).not.toContain('TOP-SECRET');
    // If buildModel resolved danger.provider, beforeEach/start would throw.
    expect(find(m, 'danger.provider').type).toBe('Provider');
  });

  it('removed /bindings and /graph', async () => {
    await client.get('/context-explorer/api/bindings').expect(404);
    await client.get('/context-explorer/api/graph').expect(404);
  });

  it('keeps the raw /inspect passthrough and serves the shell', async () => {
    const r = await client.get('/context-explorer/api/inspect').expect(200);
    expect(r.body.bindings).toBeTypeOf('object');
    const html = await client.get('/context-explorer/').expect(200);
    expect(html.text).toMatch(/<title>Test Explorer<\/title>/);
  });
});
```

- [ ] **Step 2: Confirm it fails to build (model.ts / `/model` not implemented yet)**

Run: `pnpm -F @agentback/context-explorer build`
Expected: FAIL — `installContextExplorer` still works, but the test imports/asserts a `/model` route + behaviors that don't exist. (We implement next; don't commit yet.)

---

## Task 3: Implement `model.ts` (schemas + `buildModel`)

**Files:**

- Create: `packages/context-explorer/src/model.ts`

- [ ] **Step 1: Write `model.ts`**

```ts
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
type BindingNode = z.infer<typeof BindingNode>;

// ---- Helpers ----------------------------------------------------------------

/** Normalize a `tagMap` into flat {name,value} entries; arrays fan out. */
function tagEntries(
  tagMap: Record<string, unknown>,
): z.infer<typeof TagEntry>[] {
  const out: z.infer<typeof TagEntry>[] = [];
  for (const [name, raw] of Object.entries(tagMap)) {
    if (Array.isArray(raw)) {
      for (const v of raw) out.push({name, value: String(v)});
    } else if (typeof raw === 'boolean') {
      out.push({name, value: raw});
    } else {
      out.push({name, value: String(raw)});
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
```

- [ ] **Step 2: Verify `ContextTags` import path**

Run: `pnpm exec grep -rn "export.*ContextTags\|namespace ContextTags\|const ContextTags" packages/context/src/keys.ts`
Expected: confirms `ContextTags` is exported from `@agentback/context`. If `@agentback/context` is not a direct dep, add `{"path": "../context"}` to `tsconfig.json` references and `"@agentback/context": "workspace:~"` to `package.json` deps, then `pnpm install`. (Most likely it is already transitively available; if `tsc` complains it cannot find the module, add it.)

- [ ] **Step 3: Build**

Run: `pnpm -F @agentback/context-explorer build`
Expected: `model.ts` compiles (the integration test still fails — `index.ts` doesn't serve `/model` yet).

---

## Task 4: Wire the controller to `/model` (drop `/bindings`, `/graph`)

**Files:**

- Modify: `packages/context-explorer/src/index.ts`

- [ ] **Step 1: Replace the schema + controller section**

In `index.ts`, remove the `BindingSummary`/`GraphNode`/`GraphEdge`/`ContextGraph` schemas and the `flattenInspection`/`extractGraph` functions and the `bindings()`/`graph()` controller methods. Add the import and the new method. The controller becomes:

```ts
import {ContextModel, buildModel} from './model.js';
// ...keep the existing InspectQuery + ContextInspection schemas and imports...

@api({basePath: API_BASE})
export class ContextExplorerController {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE) private readonly app: Context,
  ) {}

  /** Consolidated, derived model of the container (see model.ts). */
  @get('/model', {response: ContextModel})
  async model(): Promise<z.infer<typeof ContextModel>> {
    return buildModel(this.app);
  }

  /** Full nested `inspect()` tree — raw passthrough for the Raw view. */
  @get('/inspect', {query: InspectQuery, response: ContextInspection})
  async inspect(input: {
    query: z.infer<typeof InspectQuery>;
  }): Promise<z.infer<typeof ContextInspection>> {
    return this.app.inspect({
      includeInjections: input.query.includeInjections ?? true,
      includeParent: input.query.includeParent ?? true,
    }) as z.infer<typeof ContextInspection>;
  }
}
```

Remove now-unused imports (`JSONObject` if no longer referenced). Keep `installContextExplorer`, `contextConsoleFeature`, `mountContextExplorer`, `indexHtml`, `EXPLORER_CSS`, escapers unchanged.

- [ ] **Step 2: Build**

Run: `pnpm -F @agentback/context-explorer build`
Expected: PASS (compiles).

- [ ] **Step 3: Run the integration test**

Run: `pnpm exec vitest run packages/context-explorer/dist/__tests__/integration/explorer.integration.js`
Expected: PASS — all model assertions, including dual one-binding/two-binding paths and no-resolve.

- [ ] **Step 4: Commit**

```bash
pnpm -F @agentback/context-explorer lint:fix
git add packages/context-explorer/src
git commit -m "feat(context-explorer): consolidated /model endpoint (tags values, kinds, deps, routes/tools)"
```

---

## Task 5: Client `api.ts` — `fetchModel` + types

**Files:**

- Modify: `packages/context-explorer/src/client/api.ts`

- [ ] **Step 1: Rewrite `api.ts`**

```ts
// Copyright Ninemind.ai 2026. All Rights Reserved.
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
  extensionPoint?: string;
  extensionFor?: string[];
  configurationFor?: string;
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
```

- [ ] **Step 2: Build (will surface App.tsx/GraphView type errors — fixed in Task 6)**

Run: `pnpm -F @agentback/context-explorer build`
Expected: FAIL in `App.tsx`/`GraphView.tsx` (they still import removed types). Proceed to Task 6.

---

## Task 6: Minimal App + GraphView migration (keep current 3 views working on the model)

This keeps the app compiling/working on the new model **before** the redesign, so P0 lands green. The facet UI arrives in P1.

**Files:**

- Modify: `packages/context-explorer/src/client/App.tsx`
- Modify: `packages/context-explorer/src/client/components/GraphView.tsx`
- Modify: `packages/context-explorer/src/client/components/BindingList.tsx`
- Modify: `packages/context-explorer/src/client/components/BindingDetail.tsx`

- [ ] **Step 1: Update `App.tsx` to load the model and derive bindings/edges**

Replace the data-loading + adjacency block. Key changes: one `fetchModel`; `bindings` is `model.bindings`; edges derived from each node's `dependsOn`.

```tsx
import {useEffect, useMemo, useState} from 'react';
import {makeApi, type BindingNode, type ContextModel} from './api';
import {ApiProvider} from './ApiContext';
import {BindingList} from './components/BindingList';
import {BindingDetail} from './components/BindingDetail';
import {GraphView} from './components/GraphView';
import {RawTree} from './components/RawTree';

type View = 'browse' | 'graph' | 'raw';

export function App({
  apiBase,
  title = 'Context Explorer',
}: {
  apiBase: string;
  title?: string;
}) {
  const api = useMemo(() => makeApi(apiBase), [apiBase]);
  const [model, setModel] = useState<ContextModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<View>('browse');

  useEffect(() => {
    api.fetchModel().then(setModel, e => setError(String(e)));
  }, [api]);

  const bindings: BindingNode[] = model?.bindings ?? [];

  const {dependsOn, dependedOnBy} = useMemo(() => {
    const out = new Map<string, string[]>();
    const inc = new Map<string, string[]>();
    for (const b of bindings) {
      out.set(b.key, b.dependsOn);
      for (const to of b.dependsOn) {
        (inc.get(to) ?? inc.set(to, []).get(to)!).push(b.key);
      }
    }
    return {dependsOn: out, dependedOnBy: inc};
  }, [bindings]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return bindings.filter(
      b =>
        (!q || b.key.toLowerCase().includes(q)) &&
        (!tag || b.tags.some(t => t.name === tag)),
    );
  }, [bindings, filter, tag]);

  const selected = useMemo(
    () => bindings.find(b => b.key === selectedKey) ?? null,
    [bindings, selectedKey],
  );

  if (error) return <p className="err">Failed to load model: {error}</p>;

  const views: View[] = ['browse', 'graph', 'raw'];
  const labels: Record<View, string> = {
    browse: 'Browse',
    graph: 'Graph',
    raw: 'Raw tree',
  };

  return (
    <ApiProvider value={api}>
      <header>
        <h1>{title}</h1>
        <span className="count">
          {visible.length} / {bindings.length} bindings
        </span>
        <div className="views">
          {views.map(v => (
            <button
              key={v}
              className={v === view ? 'btn' : 'ghost'}
              onClick={() => setView(v)}
            >
              {labels[v]}
            </button>
          ))}
        </div>
      </header>

      {view === 'raw' && (
        <div style={{padding: '1.25rem 1.5rem', overflow: 'auto'}}>
          <RawTree />
        </div>
      )}

      {view === 'graph' && (
        <div className="graphpane">
          <GraphView
            selectedKey={selectedKey}
            onSelect={setSelectedKey}
            bindings={bindings}
          />
        </div>
      )}

      {view === 'browse' && (
        <div className="layout">
          <div className="list">
            <input
              className="filter"
              placeholder="Filter by key…"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            {tag && (
              <div className="tagfilter">
                tag: <span className="badge">{tag}</span>
                <button className="ghost" onClick={() => setTag(null)}>
                  clear
                </button>
              </div>
            )}
            <BindingList
              bindings={visible}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              onTag={setTag}
            />
          </div>
          <div className="detail">
            <BindingDetail
              binding={selected}
              dependsOn={selected ? (dependsOn.get(selected.key) ?? []) : []}
              dependedOnBy={
                selected ? (dependedOnBy.get(selected.key) ?? []) : []
              }
              onSelect={setSelectedKey}
            />
          </div>
        </div>
      )}
    </ApiProvider>
  );
}
```

- [ ] **Step 2: Update `BindingList.tsx` for the new tag shape + `BindingNode`**

Change the import to `BindingNode` and render tag names:

```tsx
import type {BindingNode} from '../api';

interface Props {
  bindings: BindingNode[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onTag: (tag: string) => void;
}

export function BindingList({bindings, selectedKey, onSelect, onTag}: Props) {
  if (bindings.length === 0) return <p className="empty">No bindings match.</p>;
  return (
    <>
      {bindings.map(b => (
        <button
          key={b.context + '|' + b.key}
          className={'row' + (b.key === selectedKey ? ' sel' : '')}
          onClick={() => onSelect(b.key)}
        >
          <div className="key">{b.key}</div>
          <div className="meta">
            <span className="badge">{b.scope}</span>
            {b.type && <span className="badge">{b.type}</span>}
            {b.tags.map(t => (
              <span
                key={t.name}
                className="badge tag"
                onClick={e => {
                  e.stopPropagation();
                  onTag(t.name);
                }}
              >
                {t.value === true ? t.name : `${t.name}=${t.value}`}
              </span>
            ))}
          </div>
        </button>
      ))}
    </>
  );
}
```

- [ ] **Step 3: Update `GraphView.tsx` props type**

`GraphView` takes `bindings`; change its prop type from `BindingSummary[]` to `BindingNode[]` (import from `../api`). No other logic change — it already lays out nodes; if it referenced `fetchGraph`/edges, derive edges from `bindings.flatMap(b => b.dependsOn.map(to => ({from: b.key, to})))` inside the component. Inspect the file and apply the minimal rename.

Run: `pnpm exec sed -n '1,60p' packages/context-explorer/src/client/components/GraphView.tsx` first to see its current shape, then edit.

- [ ] **Step 4: Update `BindingDetail.tsx` import + context/tags access**

Change `BindingSummary` → `BindingNode`; the rows that read `binding.tags.join(', ')` become `binding.tags.map(t => t.value === true ? t.name : t.name + '=' + t.value).join(', ')`. Leave the dependency lists as-is.

- [ ] **Step 5: Build client + full build**

Run: `pnpm -F @agentback/context-explorer build`
Expected: PASS.

- [ ] **Step 6: Run the explorer integration test again**

Run: `pnpm exec vitest run packages/context-explorer/dist/__tests__/integration/explorer.integration.js`
Expected: PASS (the HTML/bundle-serving assertions still hold).

- [ ] **Step 7: Commit**

```bash
pnpm -F @agentback/context-explorer lint:fix
git add packages/context-explorer/src/client
git commit -m "refactor(context-explorer): client consumes /model; derive edges from dependsOn"
```

---

## Task 7: Repoint the console integration test to `/model`

**Files:**

- Modify: `packages/console/src/__tests__/integration/console.integration.ts:95,124`

- [ ] **Step 1: Change both `/bindings` assertions to `/model`**

Line ~95:

```ts
const r = await client.get('/context-explorer/api/model').expect(200);
```

Line ~124:

```ts
await g.get('/context-explorer/api/model').expect(401);
```

(Keep the surrounding assertions; if line 96 asserts `Array.isArray(r.body)`, change it to `expect(r.body.bindings).toBeTypeOf('object')`.)

- [ ] **Step 2: Build + run console integration**

Run: `pnpm build && pnpm exec vitest run packages/console/dist/__tests__/integration/console.integration.js`
Expected: PASS.

- [ ] **Step 3: Full test sweep + commit**

Run: `pnpm test`
Expected: PASS (whole workspace).

```bash
git add packages/console/src/__tests__/integration/console.integration.ts
git commit -m "test(console): repoint context-explorer assertions from /bindings to /model"
```

---

# PHASE 1 — Facet shell + scope/type viz + tags (items 1, 2)

## Task 8: Pure selectors — write failing unit tests

**Files:**

- Create: `packages/context-explorer/src/__tests__/unit/selectors.unit.ts`

- [ ] **Step 1: Write the unit test**

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {
  facets,
  extensionGroups,
  configEdges,
  dualByCtor,
} from '../../lib/selectors.js';
import {buildContextTree} from '../../lib/hierarchy.js';
import type {BindingNode, ContextNode} from '../../model.js';

const node = (p: Partial<BindingNode> & {key: string}): BindingNode => ({
  key: p.key,
  context: p.context ?? 'Application',
  scope: p.scope ?? 'Singleton',
  tags: p.tags ?? [],
  kinds: p.kinds ?? [],
  dependsOn: p.dependsOn ?? [],
  ...p,
});

describe('selectors', () => {
  it('facets counts values per facet', () => {
    const f = facets([
      node({key: 'a', scope: 'Singleton', kinds: ['controller']}),
      node({key: 'b', scope: 'Transient', kinds: ['controller', 'mcpServer']}),
    ]);
    expect(f.scope.get('Singleton')).toBe(1);
    expect(f.scope.get('Transient')).toBe(1);
    expect(f.kind.get('controller')).toBe(2);
    expect(f.kind.get('mcpServer')).toBe(1);
  });

  it('extensionGroups maps point name -> extension keys', () => {
    const g = extensionGroups([
      node({key: 'pt', extensionPoint: 'greeters'}),
      node({key: 'e1', extensionFor: ['greeters']}),
      node({key: 'e2', extensionFor: ['greeters', 'other']}),
    ]);
    expect(
      g
        .get('greeters')
        ?.map(b => b.key)
        .sort(),
    ).toEqual(['e1', 'e2']);
    expect(g.get('other')?.map(b => b.key)).toEqual(['e2']);
  });

  it('configEdges links config binding to its target', () => {
    const e = configEdges([
      node({key: 'cfg', configurationFor: 'servers.RestServer'}),
      node({key: 'servers.RestServer'}),
    ]);
    expect(e.get('servers.RestServer')).toContain('cfg');
  });

  it('dualByCtor groups bindings sharing a source class', () => {
    const d = dualByCtor([
      node({key: 'controllers.X', source: 'X', kinds: ['controller']}),
      node({key: 'services.X', source: 'X', kinds: ['mcpServer']}),
      node({key: 'y', source: 'Y'}),
    ]);
    expect(d.get('X')?.length).toBe(2);
    expect(d.get('Y')?.length).toBe(1);
  });

  it('buildContextTree nests children under parents', () => {
    const contexts: ContextNode[] = [
      {name: 'Application'},
      {name: 'RestServer', parent: 'Application'},
    ];
    const tree = buildContextTree(contexts, [
      node({key: 'a', context: 'Application'}),
      node({key: 'b', context: 'RestServer'}),
    ]);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('Application');
    expect(tree[0].children[0].name).toBe('RestServer');
    expect(tree[0].children[0].bindings.map(b => b.key)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Verify it fails to build (selectors/hierarchy not created)**

Run: `pnpm -F @agentback/context-explorer build`
Expected: FAIL — modules not found.

---

## Task 9: Implement selectors + hierarchy

**Files:**

- Modify: `packages/context-explorer/src/model.ts` (export the node types)
- Create: `packages/context-explorer/src/lib/selectors.ts`
- Create: `packages/context-explorer/src/lib/hierarchy.ts`

- [ ] **Step 0: Export the node types from `model.ts`**

The selectors and the unit test need the `BindingNode`/`ContextNode` TS types. `model.ts` already declares them as local `z.infer` aliases; export them. In `model.ts` change:

```ts
type BindingNode = z.infer<typeof BindingNode>;
```

to:

```ts
export type BindingNode = z.infer<typeof BindingNode>;
export type ContextNode = z.infer<typeof ContextNode>;
```

(Add the `ContextNode` type export right after the `BindingNode` one. The `const BindingNode`/`const ContextNode` Zod schemas remain exported as before — name merging means each identifier is both a value and a type.)

- [ ] **Step 1: Write `src/lib/selectors.ts`** (pure logic, tsc-compiled, type-only import from `model.js` so esbuild keeps the browser bundle clean)

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingNode} from '../model.js';

export interface Facets {
  kind: Map<string, number>;
  scope: Map<string, number>;
  type: Map<string, number>;
  tag: Map<string, number>;
  extensionPoint: Map<string, number>;
  lifeCycleGroup: Map<string, number>;
  context: Map<string, number>;
}

const bump = (m: Map<string, number>, k: string | undefined) => {
  if (k == null) return;
  m.set(k, (m.get(k) ?? 0) + 1);
};

export function facets(bindings: BindingNode[]): Facets {
  const f: Facets = {
    kind: new Map(),
    scope: new Map(),
    type: new Map(),
    tag: new Map(),
    extensionPoint: new Map(),
    lifeCycleGroup: new Map(),
    context: new Map(),
  };
  for (const b of bindings) {
    for (const k of b.kinds) bump(f.kind, k);
    bump(f.scope, b.scope);
    bump(f.type, b.type);
    bump(f.context, b.context);
    bump(f.extensionPoint, b.extensionPoint);
    bump(f.lifeCycleGroup, b.lifeCycleGroup);
    for (const t of b.tags) bump(f.tag, t.name);
  }
  return f;
}

/** point name -> extensions contributing to it (from extensionFor values). */
export function extensionGroups(
  bindings: BindingNode[],
): Map<string, BindingNode[]> {
  const g = new Map<string, BindingNode[]>();
  for (const b of bindings) {
    for (const pt of b.extensionFor ?? []) {
      (g.get(pt) ?? g.set(pt, []).get(pt)!).push(b);
    }
  }
  return g;
}

/** target key -> config binding keys that configure it. */
export function configEdges(bindings: BindingNode[]): Map<string, string[]> {
  const e = new Map<string, string[]>();
  for (const b of bindings) {
    if (b.configurationFor == null) continue;
    const t = b.configurationFor;
    (e.get(t) ?? e.set(t, []).get(t)!).push(b.key);
  }
  return e;
}

/** source class name -> bindings sharing it (dual-binding join, finding A). */
export function dualByCtor(
  bindings: BindingNode[],
): Map<string, BindingNode[]> {
  const m = new Map<string, BindingNode[]>();
  for (const b of bindings) {
    if (!b.source) continue;
    (m.get(b.source) ?? m.set(b.source, []).get(b.source)!).push(b);
  }
  return m;
}
```

- [ ] **Step 2: Write `src/lib/hierarchy.ts`**

```ts
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingNode, ContextNode} from '../model.js';

export interface ContextTreeNode {
  name: string;
  bindings: BindingNode[];
  children: ContextTreeNode[];
}

/** Build a forest of contexts (by `parent`), each carrying its own bindings. */
export function buildContextTree(
  contexts: ContextNode[],
  bindings: BindingNode[],
): ContextTreeNode[] {
  const byName = new Map<string, ContextTreeNode>();
  for (const c of contexts) {
    if (!byName.has(c.name)) {
      byName.set(c.name, {name: c.name, bindings: [], children: []});
    }
  }
  for (const b of bindings) {
    byName.get(b.context)?.bindings.push(b);
  }
  const roots: ContextTreeNode[] = [];
  for (const c of contexts) {
    const node = byName.get(c.name)!;
    if (c.parent && byName.has(c.parent)) {
      byName.get(c.parent)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
```

- [ ] **Step 3: Build + run unit test**

Run: `pnpm -F @agentback/context-explorer build && pnpm exec vitest run packages/context-explorer/dist/__tests__/unit/selectors.unit.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
pnpm -F @agentback/context-explorer lint:fix
git add packages/context-explorer/src/lib packages/context-explorer/src/model.ts packages/context-explorer/src/__tests__/unit
git commit -m "feat(context-explorer): pure selectors (facets, extensions, config, hierarchy, dual join)"
```

---

## Task 10: FacetNav component + scope/type color tokens

**Files:**

- Create: `packages/context-explorer/src/client/components/FacetNav.tsx`
- Modify: `packages/context-explorer/src/index.ts` (extend `EXPLORER_CSS`)

- [ ] **Step 1: Write `FacetNav.tsx`**

```tsx
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {Facets} from '../../lib/selectors';

export interface FacetSelection {
  kind: Set<string>;
  scope: Set<string>;
  type: Set<string>;
  tag: Set<string>;
  context: Set<string>;
}

interface Props {
  facets: Facets;
  selection: FacetSelection;
  onToggle: (facet: keyof FacetSelection, value: string) => void;
}

const GROUPS: {
  facet: keyof FacetSelection;
  label: string;
  map: keyof Facets;
}[] = [
  {facet: 'kind', label: 'Kind', map: 'kind'},
  {facet: 'scope', label: 'Scope', map: 'scope'},
  {facet: 'type', label: 'Type', map: 'type'},
  {facet: 'context', label: 'Context', map: 'context'},
  {facet: 'tag', label: 'Tag', map: 'tag'},
];

export function FacetNav({facets, selection, onToggle}: Props) {
  return (
    <nav className="facets">
      {GROUPS.map(g => {
        const entries = [...facets[g.map].entries()].sort(
          (a, b) => b[1] - a[1],
        );
        if (!entries.length) return null;
        return (
          <section key={g.facet} className="facetgroup">
            <h3>{g.label}</h3>
            {entries.map(([value, count]) => {
              const on = selection[g.facet].has(value);
              return (
                <button
                  key={value}
                  className={'facet' + (on ? ' on' : '')}
                  onClick={() => onToggle(g.facet, value)}
                >
                  <span className={'fdot ' + g.facet + '-' + slug(value)} />
                  <span className="flabel">{value}</span>
                  <span className="fcount">{count}</span>
                </button>
              );
            })}
          </section>
        );
      })}
    </nav>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
```

- [ ] **Step 2: Add facet + scope/type color CSS to `EXPLORER_CSS` in `index.ts`**

Append to the `EXPLORER_CSS` template string:

```css
.shell {
  display: grid;
  grid-template-columns: 220px minmax(320px, 420px) 1fr;
  height: calc(100vh - 56px);
}
.facets {
  border-right: 1px solid var(--line-2);
  overflow: auto;
  padding: 0.8rem 0.6rem;
}
.facetgroup {
  margin-bottom: 1rem;
}
.facetgroup h3 {
  font-family: var(--sans);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--faint);
  margin: 0 0 0.4rem 0.3rem;
}
.facet {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.45rem;
  border: 1px solid transparent;
  background: none;
  color: inherit;
  padding: 0.28rem 0.35rem;
  border-radius: 5px;
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
}
.facet:hover {
  background: var(--card);
}
.facet.on {
  background: var(--card);
  border-color: var(--line-2);
  box-shadow: inset 3px 0 0 var(--accent);
}
.facet .flabel {
  flex: 1;
  text-align: left;
  font-family: var(--mono);
  word-break: break-all;
}
.facet .fcount {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.fdot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--line);
  flex: none;
}
.fdot.scope-singleton {
  background: #4f7d5b;
}
.fdot.scope-transient {
  background: #9a6b2f;
}
.fdot.scope-context {
  background: #3f6d8c;
}
.badge.scope-singleton {
  color: #4f7d5b;
}
.badge.scope-transient {
  color: #9a6b2f;
}
.badge.scope-context {
  color: #3f6d8c;
}
.badge.type-class {
  color: var(--blue);
}
.badge.type-provider {
  color: #7a4fa3;
}
.badge.type-constant {
  color: var(--muted);
}
.badge.type-alias {
  color: #9a6b2f;
}
.kindtag {
  font-size: 0.7rem;
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
  border: 1px solid var(--line-2);
  color: var(--accent);
}
```

- [ ] **Step 3: Build client**

Run: `pnpm -F @agentback/context-explorer build:client`
Expected: PASS (component compiles into the bundle once referenced in Task 11; if esbuild tree-shakes it for now, that's fine).

- [ ] **Step 4: Commit**

```bash
pnpm -F @agentback/context-explorer lint:fix
git add packages/context-explorer/src
git commit -m "feat(context-explorer): FacetNav component + scope/type color tokens"
```

---

## Task 11: Three-pane shell — wire FacetNav + ResultsList into App

**Files:**

- Create: `packages/context-explorer/src/client/components/ResultsList.tsx`
- Modify: `packages/context-explorer/src/client/App.tsx`

- [ ] **Step 1: Write `ResultsList.tsx`** (replaces BindingList; adds color classes + kind chips)

```tsx
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingNode} from '../api';

interface Props {
  bindings: BindingNode[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export function ResultsList({bindings, selectedKey, onSelect}: Props) {
  if (bindings.length === 0) return <p className="empty">No bindings match.</p>;
  return (
    <>
      {bindings.map(b => (
        <button
          key={b.context + '|' + b.key}
          className={'row' + (b.key === selectedKey ? ' sel' : '')}
          onClick={() => onSelect(b.key)}
        >
          <div className="key">{b.key}</div>
          <div className="meta">
            <span className={'badge scope-' + slug(b.scope)}>{b.scope}</span>
            {b.type && (
              <span className={'badge type-' + slug(b.type)}>{b.type}</span>
            )}
            {b.kinds.map(k => (
              <span key={k} className="kindtag">
                {k}
              </span>
            ))}
            {b.tags.map(t => (
              <span key={t.name} className="badge tag">
                {t.value === true ? t.name : `${t.name}=${t.value}`}
              </span>
            ))}
          </div>
        </button>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Rewire `App.tsx` browse view to the three-pane shell**

Add `facets`/`FacetNav`/`FacetSelection` imports and selection state; replace the `browse` block. Selection filtering: within-facet OR, across-facet AND.

```tsx
import {facets} from '../lib/selectors';
import {FacetNav, type FacetSelection} from './components/FacetNav';
import {ResultsList} from './components/ResultsList';
// ...
const emptySel = (): FacetSelection => ({
  kind: new Set(),
  scope: new Set(),
  type: new Set(),
  tag: new Set(),
  context: new Set(),
});
const [sel, setSel] = useState<FacetSelection>(emptySel());
const toggle = (facet: keyof FacetSelection, value: string) =>
  setSel(prev => {
    const next: FacetSelection = {...prev, [facet]: new Set(prev[facet])};
    if (next[facet].has(value)) next[facet].delete(value);
    else next[facet].add(value);
    return next;
  });

const allFacets = useMemo(() => facets(bindings), [bindings]);

const visible = useMemo(() => {
  const q = filter.trim().toLowerCase();
  const inFacet = (vals: Set<string>, has: (v: string) => boolean) =>
    vals.size === 0 || [...vals].some(has);
  return bindings.filter(
    b =>
      (!q || b.key.toLowerCase().includes(q)) &&
      inFacet(sel.kind, v => b.kinds.includes(v)) &&
      inFacet(sel.scope, v => b.scope === v) &&
      inFacet(sel.type, v => b.type === v) &&
      inFacet(sel.context, v => b.context === v) &&
      inFacet(sel.tag, v => b.tags.some(t => t.name === v)),
  );
}, [bindings, filter, sel]);
```

Replace the browse JSX:

```tsx
{
  view === 'browse' && (
    <div className="shell">
      <FacetNav facets={allFacets} selection={sel} onToggle={toggle} />
      <div className="list">
        <input
          className="filter"
          placeholder="Filter by key…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
        />
        <ResultsList
          bindings={visible}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
      </div>
      <div className="detail">
        <BindingDetail
          binding={selected}
          dependsOn={selected ? (dependsOn.get(selected.key) ?? []) : []}
          dependedOnBy={selected ? (dependedOnBy.get(selected.key) ?? []) : []}
          onSelect={setSelectedKey}
        />
      </div>
    </div>
  );
}
```

Remove the now-unused `tag`/`setTag`/`onTag` state and the `BindingList` import. Change the `browse` label to `Explore`.

- [ ] **Step 3: Build + serve check**

Run: `pnpm -F @agentback/context-explorer build`
Expected: PASS. Then run the explorer integration test (bundle still serves): `pnpm exec vitest run packages/context-explorer/dist/__tests__/integration/explorer.integration.js` → PASS.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `pnpm -F hello-hybrid start` (or any example that installs the explorer), open `/context-explorer/`, confirm facet nav filters and color badges render.

- [ ] **Step 5: Commit**

```bash
pnpm -F @agentback/context-explorer lint:fix
git add packages/context-explorer/src/client
git commit -m "feat(context-explorer): three-pane facet shell with scope/type viz + tag/kind chips"
```

---

# PHASE 2 — Extension wiring, lifecycle, config, hierarchy, app/component (items 3,4,5,6,7)

## Task 12: BindingDetail — config + extension wiring sections

**Files:**

- Modify: `packages/context-explorer/src/client/components/BindingDetail.tsx`
- Modify: `packages/context-explorer/src/client/App.tsx` (pass model-derived edges)

- [ ] **Step 1: Extend `BindingDetail` props + render**

```tsx
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import type {BindingNode} from '../api';

interface Props {
  binding: BindingNode | null;
  dependsOn: string[];
  dependedOnBy: string[];
  /** config keys configuring THIS binding (target side). */
  configuredBy: string[];
  /** extensions contributing to THIS point (if it is an extension point). */
  extensions: string[];
  onSelect: (key: string) => void;
}

export function BindingDetail({
  binding,
  dependsOn,
  dependedOnBy,
  configuredBy,
  extensions,
  onSelect,
}: Props) {
  if (!binding)
    return <p className="empty">Select a binding to see its details.</p>;
  const rows: [string, string][] = [
    ['Key', binding.key],
    ['Context', binding.context],
    ['Scope', binding.scope],
  ];
  if (binding.type) rows.push(['Type', binding.type]);
  if (binding.source) rows.push(['Source', binding.source]);
  if (binding.kinds.length) rows.push(['Kinds', binding.kinds.join(', ')]);
  rows.push([
    'Tags',
    binding.tags.length
      ? binding.tags
          .map(t => (t.value === true ? t.name : `${t.name}=${t.value}`))
          .join(', ')
      : '—',
  ]);
  if (binding.extensionPoint)
    rows.push(['Extension point', binding.extensionPoint]);
  if (binding.extensionFor?.length)
    rows.push(['Extends', binding.extensionFor.join(', ')]);
  if (binding.configurationFor)
    rows.push(['Configures', binding.configurationFor]);
  if (binding.lifeCycleGroup)
    rows.push(['Lifecycle group', binding.lifeCycleGroup]);
  if (binding.isLocked !== undefined)
    rows.push(['Locked', String(binding.isLocked)]);

  return (
    <>
      <h2>{binding.key}</h2>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} style={{display: 'contents'}}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <DepList title="Depends on" keys={dependsOn} onSelect={onSelect} />
      <DepList title="Depended on by" keys={dependedOnBy} onSelect={onSelect} />
      {binding.extensionPoint && (
        <DepList title="Extensions" keys={extensions} onSelect={onSelect} />
      )}
      <DepList title="Configured by" keys={configuredBy} onSelect={onSelect} />
      {binding.routes?.length ? <RouteList routes={binding.routes} /> : null}
      {binding.tools?.length ? <ToolList tools={binding.tools} /> : null}
    </>
  );
}

function DepList({
  title,
  keys,
  onSelect,
}: {
  title: string;
  keys: string[];
  onSelect: (k: string) => void;
}) {
  return (
    <section className="deps">
      <h3>
        {title} <span className="count">({keys.length})</span>
      </h3>
      {keys.length === 0 ? (
        <p className="empty">none</p>
      ) : (
        <ul>
          {keys.map(k => (
            <li key={k}>
              <button className="dep" onClick={() => onSelect(k)}>
                {k}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RouteList({routes}: {routes: NonNullable<BindingNode['routes']>}) {
  return (
    <section className="deps">
      <h3>
        Routes <span className="count">({routes.length})</span>
      </h3>
      <ul>
        {routes.map(r => (
          <li key={r.verb + r.path}>
            <code>
              {r.verb} {r.path}
            </code>
          </li>
        ))}
      </ul>
      <a className="dep" href="/explorer" target="_blank" rel="noreferrer">
        open in API explorer ↗
      </a>
    </section>
  );
}

function ToolList({tools}: {tools: NonNullable<BindingNode['tools']>}) {
  return (
    <section className="deps">
      <h3>
        Tools <span className="count">({tools.length})</span>
      </h3>
      <ul>
        {tools.map(t => (
          <li key={t.name}>
            <code>{t.name}</code>
            {t.description ? ` — ${t.description}` : ''}
          </li>
        ))}
      </ul>
      <a className="dep" href="/mcp-inspector" target="_blank" rel="noreferrer">
        open in MCP inspector ↗
      </a>
    </section>
  );
}
```

- [ ] **Step 2: Compute and pass `configuredBy` + `extensions` in `App.tsx`**

```tsx
import {configEdges, extensionGroups} from '../lib/selectors';
// ...
const cfgEdges = useMemo(() => configEdges(bindings), [bindings]);
const extGroups = useMemo(() => extensionGroups(bindings), [bindings]);
// in the detail JSX:
<BindingDetail
  binding={selected}
  dependsOn={selected ? (dependsOn.get(selected.key) ?? []) : []}
  dependedOnBy={selected ? (dependedOnBy.get(selected.key) ?? []) : []}
  configuredBy={selected ? (cfgEdges.get(selected.key) ?? []) : []}
  extensions={
    selected?.extensionPoint
      ? (extGroups.get(selected.extensionPoint) ?? []).map(b => b.key)
      : []
  }
  onSelect={setSelectedKey}
/>;
```

- [ ] **Step 3: Build + run integration test**

Run: `pnpm -F @agentback/context-explorer build && pnpm exec vitest run packages/context-explorer/dist/__tests__/integration/explorer.integration.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
pnpm -F @agentback/context-explorer lint:fix
git add packages/context-explorer/src/client
git commit -m "feat(context-explorer): detail-pane config + extension wiring (items 3,7)"
```

---

## Task 13: Hierarchy view + App identity card

**Files:**

- Create: `packages/context-explorer/src/client/components/HierarchyView.tsx`
- Modify: `packages/context-explorer/src/client/App.tsx` (add `hierarchy` view + app card)
- Modify: `packages/context-explorer/src/index.ts` (CSS for the tree + app card)

- [ ] **Step 1: Write `HierarchyView.tsx`**

```tsx
// Copyright ninemind.ai and LoopBack contributors. All Rights Reserved.
// Node module: @agentback/context-explorer
// This file is licensed under the MIT License.

import {buildContextTree, type ContextTreeNode} from '../../lib/hierarchy';
import type {BindingNode, ContextNode} from '../api';

interface Props {
  contexts: ContextNode[];
  bindings: BindingNode[];
  onSelect: (key: string) => void;
}

export function HierarchyView({contexts, bindings, onSelect}: Props) {
  const tree = buildContextTree(contexts, bindings);
  return (
    <div className="hierarchy">
      {tree.map(n => (
        <Ctx key={n.name} node={n} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Ctx({
  node,
  onSelect,
}: {
  node: ContextTreeNode;
  onSelect: (k: string) => void;
}) {
  return (
    <div className="ctxnode">
      <div className="ctxhead">
        <span className="ctxname">{node.name}</span>
        <span className="count">{node.bindings.length} bindings</span>
      </div>
      <ul className="ctxbindings">
        {node.bindings.map(b => (
          <li key={b.key}>
            <button className="dep" onClick={() => onSelect(b.key)}>
              {b.key}
            </button>
          </li>
        ))}
      </ul>
      {node.children.length > 0 && (
        <div className="ctxchildren">
          {node.children.map(c => (
            <Ctx key={c.name} node={c} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add `hierarchy` to the view switch + app identity card in `App.tsx`**

Add `'hierarchy'` to `View` type, `views` array, and `labels` (`hierarchy: 'Hierarchy'`). Render in the header an app card when `model.app.name` exists:

```tsx
{
  model?.app.name && (
    <span className="appcard">
      {model.app.name}
      {model.app.version ? ` v${model.app.version}` : ''}
    </span>
  );
}
```

Add the view block:

```tsx
{
  view === 'hierarchy' && (
    <div style={{padding: '1.25rem 1.5rem', overflow: 'auto'}}>
      <HierarchyView
        contexts={model?.contexts ?? []}
        bindings={bindings}
        onSelect={setSelectedKey}
      />
    </div>
  );
}
```

Import `HierarchyView`.

- [ ] **Step 3: Add CSS for `.hierarchy`, `.ctxnode`, `.appcard` to `EXPLORER_CSS`**

```css
.appcard {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--muted);
  border: 1px solid var(--line-2);
  border-radius: 4px;
  padding: 0.1rem 0.45rem;
}
.hierarchy {
  font-size: 13px;
}
.ctxnode {
  border-left: 2px solid var(--line-2);
  padding-left: 0.8rem;
  margin: 0.4rem 0;
}
.ctxhead {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  margin-bottom: 0.2rem;
}
.ctxname {
  font-family: var(--mono);
  font-weight: 600;
  color: var(--accent);
}
.ctxbindings {
  list-style: none;
  margin: 0.2rem 0;
  padding: 0;
}
.ctxchildren {
  margin-left: 0.6rem;
}
```

- [ ] **Step 4: Build + integration test + commit**

Run: `pnpm -F @agentback/context-explorer build && pnpm exec vitest run packages/context-explorer/dist/__tests__/integration/explorer.integration.js`
Expected: PASS.

```bash
pnpm -F @agentback/context-explorer lint:fix
git add packages/context-explorer/src
git commit -m "feat(context-explorer): hierarchy view + app identity card (items 5,6)"
```

---

# PHASE 3 — Controllers + MCP servers polish (items 8, 9)

> `routes`/`tools` are already in the model (Task 3) and rendered in the detail pane (Task 12). P3 adds the **dual-binding join in the UI** and the **lifecycle facet emphasis**, plus the kind-facet link-throughs and docs.

## Task 14: Dual-binding join + MCP/controller facet affordances

**Files:**

- Modify: `packages/context-explorer/src/client/components/BindingDetail.tsx`
- Modify: `packages/context-explorer/src/client/App.tsx`

- [ ] **Step 1: Surface the sibling binding for a dual class**

When the selected binding shares a `source` with another binding (the two-binding dual path, finding A), show a "Sibling registration" link so a user on the controller binding can jump to the mcpServer binding and vice-versa.

In `App.tsx`:

```tsx
import {dualByCtor} from '../lib/selectors';
// ...
const duals = useMemo(() => dualByCtor(bindings), [bindings]);
const siblings = selected?.source
  ? (duals.get(selected.source) ?? [])
      .filter(b => b.key !== selected.key)
      .map(b => b.key)
  : [];
// pass siblings={siblings} to BindingDetail
```

In `BindingDetail.tsx` add `siblings: string[]` to Props and render after the metadata `dl`:

```tsx
{
  siblings.length > 0 && (
    <DepList title="Sibling registration" keys={siblings} onSelect={onSelect} />
  );
}
```

- [ ] **Step 2: Build + integration test**

Run: `pnpm -F @agentback/context-explorer build && pnpm exec vitest run packages/context-explorer/dist/__tests__/integration/explorer.integration.js`
Expected: PASS (the two-binding `DualTwo` test already proves the model carries both; this is the UI join).

- [ ] **Step 3: Commit**

```bash
pnpm -F @agentback/context-explorer lint:fix
git add packages/context-explorer/src/client
git commit -m "feat(context-explorer): dual-binding sibling join in detail pane (item 8,9)"
```

---

## Task 15: Docs + full verification

**Files:**

- Modify: `packages/context-explorer/README.md`

- [ ] **Step 1: Rewrite the README views + API sections**

Replace the "Three views" list with: **Explore** (facet nav + results + detail), **Graph**, **Hierarchy**, **Raw**. Replace the JSON API section:

```markdown
The JSON API is fixed at `/context-explorer/api`:

- `GET /context-explorer/api/model` — the consolidated explorer model:
  `{app, contexts[], bindings[]}`. Each binding node carries scope, type, source,
  `tags` (name+value), `kinds`, `dependsOn` (direct-key injections), and — where
  applicable — `extensionPoint`/`extensionFor`, `configurationFor`,
  `lifeCycleGroup`, `routes` (controllers), and `tools` (MCP servers).
- `GET /context-explorer/api/inspect` — the raw `inspect()` tree for the Raw
  view (`includeInjections`/`includeParent` flags, both default `true`).

Read-only: bindings are never resolved, so secrets are never exposed. The sole
exception is `APPLICATION_METADATA` (a package.json object) for the app identity
card.
```

- [ ] **Step 2: Full workspace build + test**

Run: `pnpm build && pnpm test`
Expected: PASS across the workspace (context-explorer model + selectors + console repoint all green).

- [ ] **Step 3: Lint the whole workspace**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/context-explorer/README.md
git commit -m "docs(context-explorer): document /model API and the four views"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** 1 scope/type → Tasks 10–11. 2 tags → Tasks 3 (values), 11 (facet/chips). 3 extension points → Tasks 9, 12. 4 lifecycle → Task 3 (`lifeCycleGroup`), 9/11 (facet), expectation-set in spec. 5 app/component → Task 3 (`app`, `component` kind), 13 (card). 6 hierarchy → Tasks 9, 13. 7 config → Tasks 3, 9, 12. 8 controllers → Tasks 3 (routes), 12, 14. 9 MCP servers → Tasks 3 (tools), 12, 14. Enabler + endpoint consolidation → Tasks 2–7. Console breakage (finding 8) → Task 7. Dual-binding join (finding A) → Tasks 9 (`dualByCtor`), 14. Array `extensionFor` (finding B) → Task 3 (`asArray`/`tagEntries`), tested in Task 2.

**Placeholder scan:** No TBD/TODO; every code step has full code; every test has assertions; commands have expected output.

**Type consistency:** `BindingNode`/`ContextModel`/`TagEntry`/`RouteInfo`/`ToolInfo` identical across `model.ts` (Zod) and `api.ts` (TS). `Facets`/`FacetSelection` keys match between `selectors.ts`, `FacetNav.tsx`, and `App.tsx`. `buildContextTree`/`ContextTreeNode` consistent between `hierarchy.ts`, its test, and `HierarchyView.tsx`. Selector names (`facets`, `extensionGroups`, `configEdges`, `dualByCtor`, `buildContextTree`) match between definitions, unit test, and call sites.

**One thing to confirm during execution:** Task 3 Step 2 — whether `@agentback/context` must be added as a direct dep for `ContextTags`. If `tsc` resolves it transitively, skip; otherwise add the dep + reference (instructions inline).
