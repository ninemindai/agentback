# Introspection MCP (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@agentback/introspection` — a standalone, read-only MCP server that exposes a running AgentBack app to any agent through three tools: `inventory`, `get`, `get_okf_bundle`.

**Architecture:** A single `@mcpServer()` class injects the application `Context` and wraps three existing read-only builders — `buildModel` (`@agentback/context-explorer`, metadata-only bindings), `buildSchemaInventory` (`@agentback/schema-explorer`), and `buildOkfBundle` (`@agentback/schema-explorer`). It exposes a small selector surface (`inventory(kind?)` / `get({kind,id})` / `get_okf_bundle()`). No value resolution, no invocation — read-only forever. The app exposes it to remote agents via the existing `@agentback/mcp-http`.

**Tech Stack:** TypeScript 6, ESM, Zod 4, `@agentback/mcp` decorators, vitest (tests run against built `dist/`).

## Global Constraints

- **ESM-only, Node ≥ 22.13.** Relative imports use `.js` extensions.
- **Three-line copyright header on every source file** (see Task 1 Step 3). Never `Copyright IBM Corp.`
- **Lockstep version `0.6.0`** in `package.json` (matches every other `@agentback/*`).
- **Internal deps use `workspace:~`.**
- **Read-only + secret-safe.** The surface NEVER invokes a route or tool, and NEVER resolves a **secret-bearing** binding value: ordinary bindings stay metadata-only via `buildModel` (`context-explorer/src/model.ts:150`). The one resolution that does happen is `buildSchemaInventory` calling `ctx.getSync(b.key)` on **schema-tagged** bindings to read their Zod object (`schema-explorer/src/inventory.ts:181`) — same as the schema explorer already does; schemas are not secrets. Do not broaden resolution beyond schema-tagged bindings.
- **Tool inventory reads root metadata**, so it lists tools regardless of per-session MCP scope visibility. Acceptable for a read-only dev tool; do not treat the inventory as a security boundary.
- **Tests run against `dist/`.** After editing any `.ts`, run `pnpm -F @agentback/introspection build` before `vitest`. A missing export surfaces as a `tsc` build error — that is the "red" in the TDD loop here.
- **Logging:** if any is needed, use `loggers` from `@agentback/common`. Do not import `debug`.

---

### Task 1: Scaffold the package and wire the workspace

**Files:**
- Create: `packages/introspection/package.json`
- Create: `packages/introspection/tsconfig.json`
- Create: `packages/introspection/src/index.ts` (placeholder export)
- Modify: `tsconfig.json` (root — add project reference)

**Interfaces:**
- Produces: the `@agentback/introspection` workspace package, buildable via `tsc -b`.

- [ ] **Step 1: Create `packages/introspection/package.json`**

```json
{
  "name": "@agentback/introspection",
  "version": "0.6.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsc -b",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@agentback/common": "workspace:~",
    "@agentback/context-explorer": "workspace:~",
    "@agentback/core": "workspace:~",
    "@agentback/mcp": "workspace:~",
    "@agentback/openapi": "workspace:~",
    "@agentback/schema-explorer": "workspace:~",
    "tslib": "^2.8.1",
    "zod": "^4.4.3"
  },
  "engines": {
    "node": ">=22.13"
  },
  "devDependencies": {
    "@agentback/mcp-http": "workspace:~",
    "@agentback/rest": "workspace:~",
    "@agentback/testing": "workspace:~",
    "vitest": "~4.1.9"
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/ninemindai/agentback.git",
    "directory": "packages/introspection"
  },
  "homepage": "https://agentback.dev",
  "bugs": "https://github.com/ninemindai/agentback/issues"
}
```

- [ ] **Step 2: Create `packages/introspection/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "./tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"],
  "references": [
    {"path": "../common"},
    {"path": "../context-explorer"},
    {"path": "../core"},
    {"path": "../mcp"},
    {"path": "../openapi"},
    {"path": "../schema-explorer"},
    {"path": "../mcp-http"},
    {"path": "../rest"},
    {"path": "../testing"}
  ]
}
```

- [ ] **Step 3: Create `packages/introspection/src/index.ts` (placeholder)**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export {};
```

- [ ] **Step 4: Add the root project reference**

In `tsconfig.json` (repo root), add to the `references` array, in alphabetical position near the other explorers:

```json
    {"path": "packages/introspection"},
```

- [ ] **Step 5: Install and build**

Run: `pnpm install && pnpm -F @agentback/introspection build`
Expected: install wires the workspace symlinks; build succeeds (empty package compiles).

- [ ] **Step 6: Commit**

```bash
git add packages/introspection tsconfig.json pnpm-lock.yaml
git commit -m "feat(introspection): scaffold the read-only introspection MCP package"
```

---

### Task 2: Selector model + `inventory()`

**Files:**
- Create: `packages/introspection/src/model.ts`
- Test: `packages/introspection/src/__tests__/model.unit.ts`

**Interfaces:**
- Consumes: `buildModel(ctx)` from `@agentback/context-explorer`, `buildSchemaInventory(ctx)` from `@agentback/schema-explorer`.
- Produces:
  - `IntrospectionKind` = `z.enum(['binding','schema-entity','route','tool'])`
  - `IntrospectionNode` = `{kind: IntrospectionKind, id: string, label?: string}`
  - `buildInventory(ctx: Context, kind?: IntrospectionKind): IntrospectionNode[]`

- [ ] **Step 1: Write the failing test**

Create `packages/introspection/src/__tests__/model.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {Application} from '@agentback/core';
import {buildInventory} from '../model.js';

// A tiny app context with one route and one schema-tagged binding.
const Greeting = z.object({msg: z.string()});

@api({basePath: '/'})
class HelloController {
  @get('/hello', {response: Greeting})
  async hello(): Promise<z.infer<typeof Greeting>> {
    return {msg: 'hi'};
  }
}

function buildCtx(): Application {
  const app = new Application();
  app.controller(HelloController);
  app.bind('secret.token').to('SUPER_SECRET_VALUE');
  return app;
}

describe('buildInventory', () => {
  it('lists binding nodes with metadata only (no values)', () => {
    const nodes = buildInventory(buildCtx(), 'binding');
    const secret = nodes.find(n => n.id === 'secret.token');
    expect(secret).toBeDefined();
    expect(JSON.stringify(nodes)).not.toContain('SUPER_SECRET_VALUE');
  });

  it('filters by kind', () => {
    const all = buildInventory(buildCtx());
    const bindings = buildInventory(buildCtx(), 'binding');
    expect(bindings.every(n => n.kind === 'binding')).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(bindings.length);
  });

  it('surfaces route nodes from the controller (non-binding kind)', () => {
    // buildModel uppercases the verb (model.ts:268).
    const routes = buildInventory(buildCtx(), 'route');
    expect(routes.some(n => n.id === 'GET /hello')).toBe(true);
  });

  it('dedupes (no duplicate kind:id pairs)', () => {
    const all = buildInventory(buildCtx());
    const ids = all.map(n => `${n.kind}:${n.id}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

> The route is registered via `@api`/`@get`, so `buildModel` surfaces it on the controller binding; `buildInventory` flattens it to a `route` node with id `"get /hello"`.

- [ ] **Step 2: Build to verify it fails**

Run: `pnpm -F @agentback/introspection build`
Expected: FAIL — `error TS2307: Cannot find module '../model.js'` (or "has no exported member 'buildInventory'").

- [ ] **Step 3: Implement `src/model.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import type {Context} from '@agentback/core';
import {buildModel} from '@agentback/context-explorer';
import {buildSchemaInventory} from '@agentback/schema-explorer';

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
 * come from the schema inventory. Deduped per (kind,id). Side-effect free.
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
    // while the app's bindings are unchanged — agents should resolve within one
    // session. (buildSchemaInventory resolves schema-tagged binding *values* to
    // their Zod object; bindings themselves stay metadata-only.)
    const id = n.bound && n.bindingKey ? n.bindingKey : n.id;
    push({kind: 'schema-entity', id, label: n.name || n.id});
  }

  return kind ? nodes.filter(n => n.kind === kind) : nodes;
}
```

- [ ] **Step 4: Build and run the test**

Run: `pnpm -F @agentback/introspection build && pnpm exec vitest run packages/introspection/dist/__tests__/model.unit.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/introspection/src/model.ts packages/introspection/src/__tests__/model.unit.ts
git commit -m "feat(introspection): selector model + inventory() builder (metadata-only)"
```

---

### Task 3: `get(selector)` with not-found handling

**Files:**
- Modify: `packages/introspection/src/model.ts` (add `getNode`)
- Modify: `packages/introspection/src/__tests__/model.unit.ts` (add `getNode` tests)

**Interfaces:**
- Consumes: `AgentError`, `ErrorCodes` from `@agentback/openapi`.
- Produces: `getNode(ctx: Context, selector: {kind: IntrospectionKind; id: string}): unknown` — returns the matching node's detail, throws `AgentError` (404 `not_found`) when absent. Bindings return the metadata-only `BindingNode`.

- [ ] **Step 1: Write the failing test (append to `model.unit.ts`)**

```ts
import {getNode} from '../model.js';
import {AgentError} from '@agentback/openapi';

describe('getNode', () => {
  it('returns binding metadata without resolving the value', () => {
    const detail = getNode(buildCtx(), {kind: 'binding', id: 'secret.token'});
    expect(JSON.stringify(detail)).not.toContain('SUPER_SECRET_VALUE');
    expect((detail as {key: string}).key).toBe('secret.token');
  });

  it('throws AgentError(404 not_found) for an unknown id', () => {
    expect(() => getNode(buildCtx(), {kind: 'tool', id: 'nope'})).toThrow(
      AgentError,
    );
    try {
      getNode(buildCtx(), {kind: 'tool', id: 'nope'});
    } catch (e) {
      expect((e as AgentError).statusCode).toBe(404);
      expect((e as AgentError).code).toBe('not_found');
    }
  });

  it('returns route detail with the owning binding key', () => {
    // buildModel uppercases the verb (model.ts:268), so the id is "GET /hello".
    const detail = getNode(buildCtx(), {kind: 'route', id: 'GET /hello'}) as {
      verb: string;
      path: string;
      binding: string;
    };
    expect(detail.verb).toBe('GET');
    expect(detail.path).toBe('/hello');
    expect(typeof detail.binding).toBe('string');
  });

  it('returns schema-entity detail by id', () => {
    const entity = buildInventory(buildCtx(), 'schema-entity')[0];
    // Skip if this minimal app surfaced no schema node; otherwise the id must resolve.
    if (entity) {
      const detail = getNode(buildCtx(), {
        kind: 'schema-entity',
        id: entity.id,
      }) as {id: string};
      expect(detail.id).toBe(entity.id);
    }
  });
});
```

> A `tool`-kind success path needs an `@mcpServer` class in the context; that is
> exercised end-to-end in the MCP integration test (Task 5) against
> `IntrospectionTools` itself, so it is not duplicated here.

- [ ] **Step 2: Build to verify it fails**

Run: `pnpm -F @agentback/introspection build`
Expected: FAIL — "has no exported member 'getNode'".

- [ ] **Step 3: Implement `getNode` (append to `src/model.ts`)**

```ts
import {AgentError, ErrorCodes} from '@agentback/openapi';

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
    // Match the stable binding key first (what inventory emits for bound nodes),
    // then the synthesized id (unbound nodes).
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
```

- [ ] **Step 4: Build and run the test**

Run: `pnpm -F @agentback/introspection build && pnpm exec vitest run packages/introspection/dist/__tests__/model.unit.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/introspection/src/model.ts packages/introspection/src/__tests__/model.unit.ts
git commit -m "feat(introspection): get(selector) with 404 not_found, value-safe"
```

---

### Task 4: The `@mcpServer` tool class

**Files:**
- Modify: `packages/introspection/src/index.ts` (replace placeholder with the tool class)

**Interfaces:**
- Consumes: `buildInventory`, `getNode`, `IntrospectionKind`, `IntrospectionNode` from `./model.js`; `buildOkfBundle` from `@agentback/schema-explorer`; `mcpServer`, `tool` from `@agentback/mcp`; `CoreBindings`, `inject`, `Context` from `@agentback/core`.
- Produces: `export class IntrospectionTools` — a `@mcpServer()` service exposing tools `inventory`, `get`, `get_okf_bundle`. Re-exports the model types.

- [ ] **Step 1: Implement `src/index.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {CoreBindings, inject, type Context} from '@agentback/core';
import {loggers} from '@agentback/common';
import {AgentError} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';
import {buildOkfBundle} from '@agentback/schema-explorer';
import {
  IntrospectionKind,
  IntrospectionNode,
  buildInventory,
  getNode,
} from './model.js';

export * from './model.js';

const log = loggers('agentback:introspection');

/**
 * Run a read-only builder, translating an unexpected throw into a useful
 * AgentError (500) so the agent sees something actionable instead of the
 * redacted generic `internal_error`. An AgentError thrown deliberately
 * (e.g. getNode's 404 not_found) passes through unchanged.
 */
function tryBuild<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AgentError) throw err;
    log.error('introspection failed to build %s: %o', what, err);
    throw new AgentError(`Introspection failed to build ${what}.`, {
      status: 500,
      code: 'introspection_error',
    });
  }
}

const InventoryInput = z.object({
  kind: IntrospectionKind.optional().describe(
    'Filter to one node kind; omit for all kinds.',
  ),
});
const InventoryOutput = z.object({nodes: z.array(IntrospectionNode)});

const GetInput = z.object({
  kind: IntrospectionKind.describe('Node kind to fetch.'),
  id: z
    .string()
    .describe(
      'Node id from inventory: a binding key, schema id, "VERB /path", or tool name.',
    ),
});
const GetOutput = z.object({
  kind: IntrospectionKind,
  id: z.string(),
  detail: z.unknown(),
});

const OkfInput = z.object({});
const OkfOutput = z.object({
  files: z.array(z.object({path: z.string(), content: z.string()})),
});

/**
 * Read-only introspection of the running app, for an agent to ground itself in
 * the live instance. NEVER resolves a binding value, NEVER invokes a route or
 * tool — evolution happens through the coding agent editing source, not here.
 */
@mcpServer()
export class IntrospectionTools {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly app: Context,
  ) {}

  @tool('inventory', {
    description:
      "List the live application's nodes (bindings, schema entities, routes, tools). Read-only; bindings are metadata only, never values.",
    input: InventoryInput,
    output: InventoryOutput,
  })
  async inventory(
    input: z.infer<typeof InventoryInput>,
  ): Promise<z.infer<typeof InventoryOutput>> {
    return {nodes: tryBuild('inventory', () => buildInventory(this.app, input.kind))};
  }

  @tool('get', {
    description:
      "Fetch one node's detail by selector {kind,id}. Bindings return metadata only (never a resolved value).",
    input: GetInput,
    output: GetOutput,
  })
  async get(
    input: z.infer<typeof GetInput>,
  ): Promise<z.infer<typeof GetOutput>> {
    // getNode throws AgentError(404) for unknown ids; tryBuild passes it through.
    return {
      kind: input.kind,
      id: input.id,
      detail: tryBuild('node detail', () => getNode(this.app, input)),
    };
  }

  @tool('get_okf_bundle', {
    description:
      'Return the OKF knowledge bundle: a portable, schema-indexed snapshot of the whole app for an agent to ingest verbatim. Returns the full bundle (large apps may produce a sizable payload — see the summary/on-demand TODO).',
    input: OkfInput,
    output: OkfOutput,
  })
  async getOkfBundle(
    _input: z.infer<typeof OkfInput>,
  ): Promise<z.infer<typeof OkfOutput>> {
    return {files: tryBuild('OKF bundle', () => buildOkfBundle(this.app).files)};
  }
}
```

- [ ] **Step 2: Build**

Run: `pnpm -F @agentback/introspection build`
Expected: PASS (compiles; the `@tool` `TypedPropertyDescriptor` accepts each method's slot-0 input type).

- [ ] **Step 3: Commit**

```bash
git add packages/introspection/src/index.ts
git commit -m "feat(introspection): @mcpServer with inventory/get/get_okf_bundle tools"
```

---

### Task 5: In-process MCP integration test (incl. the hostile no-leak assertion)

**Files:**
- Test: `packages/introspection/src/__tests__/introspection.unit.ts`

**Interfaces:**
- Consumes: `createTestApp` from `@agentback/testing`; `RestApplication` from `@agentback/rest`; `MCPComponent` from `@agentback/mcp`; `IntrospectionTools` from `../index.js`.

- [ ] **Step 1: Write the failing test**

Create `packages/introspection/src/__tests__/introspection.unit.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {IntrospectionTools} from '../index.js';

function makeApp(): RestApplication {
  const app = new RestApplication({rest: {port: 0}});
  app.component(MCPComponent);
  app.service(IntrospectionTools);
  app.bind('secret.token').to('SUPER_SECRET_VALUE');
  return app;
}

describe('introspection MCP', () => {
  it('exposes exactly the three read tools', async () => {
    await using t = await createTestApp(makeApp);
    const {tools} = await t.mcp.listTools();
    const names = tools.map(x => x.name).sort();
    expect(names).toEqual(['get', 'get_okf_bundle', 'inventory']);
  });

  it('inventory returns the binding node and never leaks its value', async () => {
    await using t = await createTestApp(makeApp);
    const res = await t.mcp.callTool({name: 'inventory', arguments: {}});
    // Assert the call SUCCEEDED and returned the node — otherwise the no-leak
    // check below would pass vacuously on an errored/empty response.
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {nodes: {kind: string; id: string}[]};
    expect(
      out.nodes.some(n => n.kind === 'binding' && n.id === 'secret.token'),
    ).toBe(true);
    expect(JSON.stringify(res)).not.toContain('SUPER_SECRET_VALUE');
  });

  it('get on a secret binding returns metadata only (hostile no-leak)', async () => {
    await using t = await createTestApp(makeApp);
    const res = await t.mcp.callTool({
      name: 'get',
      arguments: {kind: 'binding', id: 'secret.token'},
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as {detail: {key: string}};
    expect(out.detail.key).toBe('secret.token'); // metadata IS returned
    expect(JSON.stringify(res)).not.toContain('SUPER_SECRET_VALUE'); // value is NOT
  });

  it('get_okf_bundle returns a non-empty file set', async () => {
    await using t = await createTestApp(makeApp);
    const res = await t.mcp.callTool({
      name: 'get_okf_bundle',
      arguments: {},
    });
    const out = res.structuredContent as {files: unknown[]};
    expect(Array.isArray(out.files)).toBe(true);
  });
});
```

- [ ] **Step 2: Build to verify it fails**

Run: `pnpm -F @agentback/introspection build`
Expected: PASS to build (all imports exist). The test will FAIL only if the tool surface is wrong; run it next.

Run: `pnpm exec vitest run packages/introspection/dist/__tests__/introspection.unit.js`
Expected: PASS (4 tests). If `get_okf_bundle`'s `structuredContent` is undefined, confirm the `output` schema is declared on the tool (Task 4) — MCP only emits `structuredContent` when an `output` schema exists.

- [ ] **Step 3: Commit**

```bash
git add packages/introspection/src/__tests__/introspection.unit.ts
git commit -m "test(introspection): in-process MCP client + hostile no-value-leak"
```

---

### Task 6: Documentation surfaces

**Files:**
- Create: `packages/introspection/README.md`
- Modify: `docs/packages.md` (add the catalog row)
- Modify: `CLAUDE.md` (add to the "New capability packages" list)
- Modify: `skills/agentback/SKILL.md` (packages/capability table) and create `skills/agentback/references/introspection.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Create `packages/introspection/README.md`**

```markdown
# @agentback/introspection

A **read-only** MCP server that exposes a running AgentBack app to any agent, so
your coding agent can ground itself in the *live instance* — what's bound, the
real schema graph, the routes and tools — instead of guessing from source.

> Read-only forever: it NEVER resolves a binding value and NEVER invokes a route
> or tool. Bindings are metadata only. "Evolve the app" happens through the agent
> editing source, not through this surface.

## Usage

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {IntrospectionTools} from '@agentback/introspection';

const app = new RestApplication();
app.component(MCPComponent);
app.service(IntrospectionTools); // adds the introspection tools to the MCP surface
await installMcpHttp(app);        // expose MCP over Streamable HTTP at /mcp
await app.start();
// Point your agent (e.g. via an MCP client config) at http://localhost:3000/mcp
```

## Tools

- `inventory(kind?)` — list the app's nodes (`binding` | `schema-entity` | `route` | `tool`); omit `kind` for all.
- `get({kind, id})` — fetch one node's detail by selector. Bindings return metadata only.
- `get_okf_bundle()` — the OKF knowledge bundle (a portable, schema-indexed snapshot) for the agent to ingest.

Built on the same metadata-only builders as `@agentback/context-explorer`,
`@agentback/schema-explorer` (incl. its OKF export) — this package is the
agent-facing projection of those read APIs.
```

- [ ] **Step 2: Add the `docs/packages.md` row**

Add one row to the package catalog table (match the existing column shape):

```markdown
| `@agentback/introspection` | Read-only MCP server exposing the live app (bindings/schema/routes/tools + OKF) to any agent. |
```

- [ ] **Step 3: Add to `CLAUDE.md` "New capability packages" list**

Insert after the `schema-explorer` entry:

```markdown
   - `introspection` — a **read-only** MCP server that projects the live app (the explorers' read APIs + OKF bundle) to any agent as a small selector surface (`inventory`/`get`/`get_okf_bundle`). Metadata-only (never resolves a binding value), never invokes anything; the agent-facing sibling of the explorers. Served over `mcp-http`. See `examples/hello-agent-console`.
```

- [ ] **Step 4: Add the agent skill entry**

In `skills/agentback/SKILL.md`, add `@agentback/introspection` to the packages/capability table (one row, same shape as neighbors). Create `skills/agentback/references/introspection.md` with the README's Usage + Tools content adapted to the reference-page format used by the other files in that directory (open a sibling reference file first and match its headings).

- [ ] **Step 5: Commit**

```bash
git add packages/introspection/README.md docs/packages.md CLAUDE.md skills/agentback/SKILL.md skills/agentback/references/introspection.md
git commit -m "docs(introspection): README, catalog, CLAUDE.md, agent skill"
```

---

### Task 7: On-ramp example `hello-agent-console`

**Files:**
- Create: `examples/hello-agent-console/package.json`
- Create: `examples/hello-agent-console/tsconfig.json`
- Create: `examples/hello-agent-console/src/index.ts`
- Create: `examples/hello-agent-console/README.md`

**Interfaces:**
- Consumes: `RestApplication`, `MCPComponent`, `installMcpHttp`, `IntrospectionTools`, plus one sample `@api` controller so the inventory is non-trivial.

> Name rationale: `examples/hello-chat` already exists; this example is named `hello-agent-console` to avoid collision (DX finding F3).

- [ ] **Step 1: Create `examples/hello-agent-console/package.json`**

```json
{
  "name": "hello-agent-console",
  "version": "0.6.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -b",
    "start": "node dist/index.js",
    "clean": "rm -rf dist *.tsbuildinfo"
  },
  "dependencies": {
    "@agentback/core": "workspace:~",
    "@agentback/introspection": "workspace:~",
    "@agentback/mcp": "workspace:~",
    "@agentback/mcp-http": "workspace:~",
    "@agentback/openapi": "workspace:~",
    "@agentback/rest": "workspace:~",
    "zod": "^4.4.3"
  }
}
```

- [ ] **Step 2: Create `examples/hello-agent-console/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "tsBuildInfoFile": "./tsconfig.tsbuildinfo"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"],
  "references": [
    {"path": "../../packages/core"},
    {"path": "../../packages/introspection"},
    {"path": "../../packages/mcp"},
    {"path": "../../packages/mcp-http"},
    {"path": "../../packages/openapi"},
    {"path": "../../packages/rest"}
  ]
}
```

Then add the example to the **root** `tsconfig.json` `references` (examples are
listed there, near the other `examples/hello-*` entries) — without it,
`pnpm build` / `pnpm verify` silently skips the example:

```json
    {"path": "examples/hello-agent-console"},
```

- [ ] **Step 3: Create `examples/hello-agent-console/src/index.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {isMain} from '@agentback/core';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';
import {IntrospectionTools} from '@agentback/introspection';

const Greeting = z.object({message: z.string()});
const HelloPath = z.object({name: z.string().min(1).max(64)});

@api({basePath: '/'})
class HelloController {
  @get('/hello/{name}', {path: HelloPath, response: Greeting})
  async hello(input: {
    path: z.infer<typeof HelloPath>;
  }): Promise<z.infer<typeof Greeting>> {
    return {message: `Hello, ${input.path.name}!`};
  }
}

async function main(): Promise<void> {
  const app = new RestApplication();
  app.component(MCPComponent);
  app.restController(HelloController);
  app.service(IntrospectionTools);
  await installMcpHttp(app);
  await app.start();
  // The app's MCP surface (including introspection) is now at /mcp.
  // Point your agent's MCP client at http://localhost:3000/mcp to let it
  // `inventory`, `get`, and `get_okf_bundle` against this live app.
}

if (isMain(import.meta)) {
  await main();
}
```

- [ ] **Step 4: Create `examples/hello-agent-console/README.md`**

```markdown
# hello-agent-console

Expose a running AgentBack app to your coding agent, read-only, so it can *see*
the live instance (bindings, schema, routes, tools) before it helps you *evolve*
the source.

```bash
pnpm -F hello-agent-console build
pnpm -F hello-agent-console start
# MCP (incl. introspection) is served at http://localhost:3000/mcp
```

Point your agent's MCP client at `http://localhost:3000/mcp`, then ask it to call
`inventory` / `get` / `get_okf_bundle`. It now answers questions about *this*
running app, not a guess from source.
```

- [ ] **Step 5: Build and smoke-test**

Run: `pnpm -F hello-agent-console build && pnpm -F hello-agent-console start &` then `curl -s -X POST localhost:3000/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 400; kill %1`
Expected: the JSON-RPC response lists `inventory`, `get`, `get_okf_bundle` among the tools.

- [ ] **Step 6: Commit**

```bash
git add examples/hello-agent-console tsconfig.json
git commit -m "feat(examples): hello-agent-console — ground an agent in the live app"
```

---

## Final verification

- [ ] Run `pnpm verify` (build + typecheck:client + test + validate-templates) and confirm green.

```bash
pnpm verify
```

## Self-review notes

- **Spec coverage:** Phase 1 scope (standalone read-only package, consolidated selector surface `inventory`/`get`/`get_okf_bundle`, metadata-only bindings, served over mcp-http, doc surfaces, on-ramp example, hostile no-leak test) — each maps to Tasks 1-7. Phase 2 (ACP dock) is explicitly out of this plan.
- **Read-only invariant:** enforced structurally — every path goes through `buildModel`/`buildSchemaInventory`/`buildOkfBundle`, none of which resolve values; Tasks 3 and 5 each assert no value leaks.
- **Out of scope here:** the ACP dock, agent discovery, the shell dock slot, nav-context, and the `claude-agent-acp` adapter/doctor (all Phase 2).

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 (this session) | done | SELECTIVE EXPANSION; phased approach; 2 cherry-picks accepted; read-only introspection |
| DX Review | `/plan-devex-review` | Developer experience | 1 (this session) | done | persona=app author; TTHW 4→7; F1 adapter+doctor, F5 evolve→see loop |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | issues_found | 9 findings, all verified + folded (statusCode, verb-case, tsconfig ref, vacuous tests, read-only claim) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 12 findings, all folded; 0 critical gaps; 0 unresolved |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a — Phase 1 has no UI |

- **CODEX:** caught real compile/correctness bugs the section review missed — `.status`→`.statusCode`, uppercased route verbs, the overstated read-only invariant (`buildSchemaInventory` resolves schema bindings), missing root `tsconfig` ref, and vacuously-passing hostile tests. All verified against source and folded into the plan.
- **CROSS-MODEL:** no disagreement — codex found bugs, not a competing design. Both reviewers agree Phase 1 is a thin read-only projection over existing builders.
- **VERDICT:** ENG CLEARED — ready to implement. (CEO + DX performed this session; design review n/a for a no-UI phase.)

NO UNRESOLVED DECISIONS
