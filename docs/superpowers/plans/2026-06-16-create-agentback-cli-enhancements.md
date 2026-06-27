# create-agentback CLI Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interactive prompts, runnable capability flags (`--drizzle`, `--auth`), and HTTP host options (`--port`/`--host`/`--base-path`) to `create-agentback`, built on a declarative capability registry.

**Architecture:** A new `capabilities.ts` registry holds one declarative entry per add-on (deps + per-template wiring strings + overlay files). `scaffold()` copies the base template, then for each selected capability merges deps, copies overlay files, and injects wiring at named `// {{agentback:*}}` anchor comments the base templates ship. `--console` is refactored into the same registry. Interactive mode (`@clack/prompts`) runs only when no app name is given on a TTY and fills whatever flags left unset.

**Tech Stack:** TypeScript 6, ESM, Node 22.13+, `@clack/prompts`, vitest. Tests run from built `dist/` (run `pnpm -F create-agentback build` before `pnpm exec vitest`).

---

## Critical conventions (read before starting)

- **Build before test.** This repo runs vitest against `dist/`. After any `.ts` edit in `packages/create-agentback`, run `pnpm -F create-agentback build` before tests.
- **Branch.** Work happens on `feat/create-agentback-cli-enhancements` (already created; the design spec is committed there).
- **License header** on every new source file:
  ```ts
  // Copyright NineMind, Inc. 2026. All Rights Reserved.
  // This file is licensed under the MIT License.
  // License text available at https://opensource.org/license/mit/
  ```
  (Note: existing template `src/*.ts` files intentionally omit headers — match the file you're editing. New `packages/create-agentback/src/*.ts` files DO get the header.)
- **Anchors vs tokens.** `{{agentback:*}}` are wiring anchors (filled/stripped by capability logic). `{{name}}`/`{{version}}` are substitution tokens (handled by the existing pass). They must not collide: the `SUBSTITUTED` regex only matches `{{name}}`/`{{version}}`, never `{{agentback:*}}`.

---

## File Structure

**New files:**
- `packages/create-agentback/src/capabilities.ts` — the registry + `applyCapability`/anchor helpers.
- `packages/create-agentback/src/__tests__/capabilities.test.ts` — capability + host-option unit tests.
- `packages/create-agentback/templates/_capabilities/drizzle/_shared/src/db/schema.ts`
- `packages/create-agentback/templates/_capabilities/drizzle/_shared/src/stores/user-store.ts`
- `packages/create-agentback/templates/_capabilities/drizzle/_shared/.env.example`
- `packages/create-agentback/templates/_capabilities/drizzle/rest/src/controllers/users.controller.ts`
- `packages/create-agentback/templates/_capabilities/drizzle/hybrid/src/controllers/users.controller.ts`
- `packages/create-agentback/templates/_capabilities/drizzle/mcp/src/tools/users.tools.ts`
- `packages/create-agentback/templates/_capabilities/auth/_shared/src/controllers/auth.controller.ts`
- `packages/create-agentback/templates/_capabilities/auth/_shared/.env.example`

**Modified files:**
- `packages/create-agentback/src/scaffold.ts` — registry-driven apply, host options, anchor strip; `--console` folded in.
- `packages/create-agentback/src/cli.ts` — new flags + interactive mode.
- `packages/create-agentback/templates/{hybrid,rest,mcp}/src/application.ts` — anchor comments.
- `packages/create-agentback/package.json` — add `@clack/prompts`.
- `scripts/validate-templates.mjs` — add a capability combo to the matrix.
- `packages/create-agentback/README.md` (if present) / CLI usage text — document new flags + interactive mode.

---

## Task 1: Add wiring anchors to the base templates

**Files:**
- Modify: `packages/create-agentback/templates/rest/src/application.ts`
- Modify: `packages/create-agentback/templates/hybrid/src/application.ts`
- Modify: `packages/create-agentback/templates/mcp/src/application.ts`

These edits are pure template prep; they're verified by the anchor-strip test in Task 2 (a base scaffold with no capabilities must strip them and still build).

- [ ] **Step 1: Add anchors to `rest/src/application.ts`**

Replace the whole file with:

```ts
// {{agentback:imports}}
import {RestApplication} from '@agentback/rest';
import {GreetingController} from './controllers/greeting.controller.js';

export class Application extends RestApplication {
  constructor() {
    super({/* {{agentback:rest-config}} */});
    // {{agentback:components}}
    this.restController(GreetingController);
    // {{agentback:registrations}}
  }
}
```

- [ ] **Step 2: Add anchors to `hybrid/src/application.ts`**

Replace the whole file with (keeps existing MCP wiring + the dual-registration comment):

```ts
// {{agentback:imports}}
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {GreetingController} from './controllers/greeting.controller.js';

export class Application extends RestApplication {
  constructor() {
    super({/* {{agentback:rest-config}} */});
    this.component(MCPComponent);
    this.configure('servers.MCPServer').to({
      name: '{{name}}',
      version: '0.1.0',
      transports: {stdio: false},
    });
    // {{agentback:components}}
    // One class, two surfaces — both registrations are needed. `restController`
    // serves the REST routes; `service` registers the same class as an MCP tool
    // (the `@mcpServer` tag drives discovery, and the dispatcher resolves it with
    // constructor `@inject`). `restController` tags it for REST only, so drop
    // `service` and the MCP surface goes dark.
    this.restController(GreetingController);
    this.service(GreetingController);
    // {{agentback:registrations}}
  }
}
```

- [ ] **Step 3: Add anchors to `mcp/src/application.ts`**

Replace the whole file with (no `rest-config` anchor — stdio app has no REST server):

```ts
// {{agentback:imports}}
import {Application as CoreApplication} from '@agentback/core';
import {MCPComponent} from '@agentback/mcp';
import {EchoTools} from './tools/echo.tools.js';

export class Application extends CoreApplication {
  constructor(options: {stdio?: boolean} = {}) {
    super();
    this.component(MCPComponent);
    this.configure('servers.MCPServer').to({
      name: '{{name}}',
      version: '0.1.0',
      transports: {stdio: options.stdio ?? true},
    });
    // {{agentback:components}}
    // A tool class is a DI service. The MCP server discovers it by the
    // `@mcpServer` tag and resolves it (with constructor `@inject`) through its
    // binding, so any constructor dependencies are injected.
    this.service(EchoTools);
    // {{agentback:registrations}}
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/create-agentback/templates/*/src/application.ts
git commit -m "feat(create-agentback): add wiring anchors to base templates"
```

---

## Task 2: Anchor fill/strip helpers + host options in `scaffold()`

**Files:**
- Modify: `packages/create-agentback/src/scaffold.ts`
- Test: `packages/create-agentback/src/__tests__/capabilities.test.ts` (create)

The anchor helpers and host-option rendering live in `scaffold.ts` (anchors are a scaffold concern). `ScaffoldOptions` gains `host`.

- [ ] **Step 1: Write the failing test**

Create `packages/create-agentback/src/__tests__/capabilities.test.ts`:

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, readFileSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import path from 'path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {scaffold} from '../scaffold.js';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), 'cab-'));
});
afterEach(() => {
  rmSync(cwd, {recursive: true, force: true});
});

function appFile(dir: string, rel: string): string {
  return readFileSync(path.join(dir, rel), 'utf8');
}

describe('host options + anchor stripping', () => {
  it('strips all anchors from a plain rest scaffold', () => {
    const {dir} = scaffold({name: 'plain', template: 'rest', cwd});
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).not.toContain('{{agentback:');
    expect(appTs).toContain('super({})');
  });

  it('renders host options into the rest config', () => {
    const {dir} = scaffold({
      name: 'hosted',
      template: 'rest',
      cwd,
      host: {port: 8080, host: '0.0.0.0', basePath: '/api'},
    });
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).toContain("rest: {port: 8080, host: '0.0.0.0', basePath: '/api'}");
    expect(appTs).not.toContain('{{agentback:');
  });

  it('rejects host options for the stdio mcp template', () => {
    expect(() =>
      scaffold({name: 'bad', template: 'mcp', cwd, host: {port: 9000}}),
    ).toThrow(/host options.*mcp/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F create-agentback build
pnpm exec vitest run packages/create-agentback/dist/__tests__/capabilities.test.js
```
Expected: FAIL — `super({})` still contains the anchor (`{{agentback:rest-config}}`) and `host` is not a known option.

- [ ] **Step 3: Add host typing + anchor helpers to `scaffold.ts`**

In `packages/create-agentback/src/scaffold.ts`, extend `ScaffoldOptions` (after the `console?` field):

```ts
  /**
   * HTTP host options baked into the scaffolded RestApplication config.
   * Rejected for the stdio `mcp` template (no REST server). Omitted keys fall
   * back to framework defaults (3000/127.0.0.1) and runtime PORT/HOST env.
   */
  host?: {port?: number; host?: string; basePath?: string};
```

Add these helpers near the top of the file (after `SUBSTITUTED`):

```ts
/** Templates that have an HTTP server (and thus accept host options). */
const REST_TEMPLATES: readonly TemplateName[] = ['hybrid', 'rest'];

/** Render the `rest: {...}` config body from host options (no surrounding braces). */
function renderRestConfig(host?: ScaffoldOptions['host']): string {
  if (!host) return '';
  const parts: string[] = [];
  if (host.port !== undefined) parts.push(`port: ${host.port}`);
  if (host.host !== undefined) parts.push(`host: '${host.host}'`);
  if (host.basePath !== undefined) parts.push(`basePath: '${host.basePath}'`);
  return parts.length ? `rest: {${parts.join(', ')}}` : '';
}

/**
 * Fill a named anchor in a file, re-emitting the anchor so multiple capabilities
 * can stack at the same point. `kind: 'line'` targets `// {{agentback:tag}}`;
 * `kind: 'inline'` targets `/* {{agentback:tag}} *␐/` (used inside `super(...)`).
 */
function fillAnchor(
  text: string,
  tag: string,
  insert: string,
  kind: 'line' | 'inline' = 'line',
): string {
  if (kind === 'inline') {
    const re = new RegExp(`/\\* \\{\\{agentback:${tag}\\}\\} \\*/`);
    return text.replace(re, insert);
  }
  const re = new RegExp(`([ \\t]*)// \\{\\{agentback:${tag}\\}\\}`);
  return text.replace(re, (_m, indent: string) => `${indent}${insert}\n${indent}// {{agentback:${tag}}}`);
}

/** Remove every remaining `{{agentback:*}}` anchor (line + inline forms). */
function stripAnchors(text: string): string {
  return text
    .replace(/^[ \t]*\/\/ \{\{agentback:[^}]+\}\}\n/gm, '')
    .replace(/\/\* \{\{agentback:[^}]+\}\} \*\//g, '');
}
```

> Note: in the comment above, write the inline close as `*/` — the `*␐/` in this plan only avoids closing this code block.

- [ ] **Step 4: Wire host options + anchor strip into `scaffold()`**

In `scaffold()`, after the `--console`/`main.console.ts` handling block and BEFORE the `{{name}}`/`{{version}}` substitution loop, insert:

```ts
  // Host options → RestApplication config. Rejected for the stdio mcp template.
  if (options.host && !REST_TEMPLATES.includes(template)) {
    throw new Error(
      `host options are not supported for the '${template}' template; it has ` +
        `no HTTP server. Use --template ${REST_TEMPLATES.join(' or ')}.`,
    );
  }
  const appTsPath = path.join(dir, 'src', 'application.ts');
  if (existsSync(appTsPath)) {
    let appTs = readFileSync(appTsPath, 'utf8');
    const restConfig = renderRestConfig(options.host);
    if (restConfig) appTs = fillAnchor(appTs, 'rest-config', restConfig, 'inline');
    appTs = stripAnchors(appTs);
    writeFileSync(appTsPath, appTs);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm -F create-agentback build
pnpm exec vitest run packages/create-agentback/dist/__tests__/capabilities.test.js
```
Expected: PASS (3 tests).

- [ ] **Step 6: Run the existing scaffold test suite (regression)**

```bash
pnpm exec vitest run packages/create-agentback/dist/__tests__
```
Expected: PASS — existing template/scaffold tests unaffected (base scaffolds now strip anchors transparently).

- [ ] **Step 7: Commit**

```bash
git add packages/create-agentback/src/scaffold.ts packages/create-agentback/src/__tests__/capabilities.test.ts
git commit -m "feat(create-agentback): anchor fill/strip helpers + --port/--host/--base-path host options"
```

---

## Task 3: Capability registry + refactor `--console` into it

**Files:**
- Create: `packages/create-agentback/src/capabilities.ts`
- Modify: `packages/create-agentback/src/scaffold.ts`
- Test: `packages/create-agentback/src/__tests__/capabilities.test.ts`

- [ ] **Step 1: Write the failing test (append to `capabilities.test.ts`)**

```ts
import {CAPABILITIES, capabilityNames} from '../capabilities.js';

describe('capability registry', () => {
  it('lists console as a registered capability for rest+hybrid only', () => {
    const cap = CAPABILITIES.find(c => c.name === 'console');
    expect(cap).toBeDefined();
    expect(cap!.templates).toEqual(['hybrid', 'rest']);
  });

  it('exposes capability names valid for a given template', () => {
    expect(capabilityNames('mcp')).not.toContain('console');
    expect(capabilityNames('rest')).toContain('console');
  });

  it('--console via capabilities retargets deps to @agentback/console', () => {
    const {dir} = scaffold({
      name: 'consoled',
      template: 'hybrid',
      cwd,
      capabilities: ['console'],
    });
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@agentback/console']).toBeDefined();
    expect(pkg.dependencies['@agentback/rest-explorer']).toBeUndefined();
  });

  it('rejects a capability incompatible with the template', () => {
    expect(() =>
      scaffold({name: 'x', template: 'mcp', cwd, capabilities: ['console']}),
    ).toThrow(/console.*mcp/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F create-agentback build
```
Expected: FAIL — `capabilities.ts` does not exist (build error / import failure).

- [ ] **Step 3: Create `packages/create-agentback/src/capabilities.ts`**

```ts
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {cpSync, existsSync, readFileSync, writeFileSync} from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import type {TemplateName} from './scaffold.js';

export interface CapabilityContext {
  /** Scaffolded app directory. */
  dir: string;
  /** Chosen template. */
  template: TemplateName;
  /** `_capabilities/` root inside the package. */
  capRoot: string;
}

/** A wiring snippet injected at a named anchor, per template. */
interface Wiring {
  imports?: string;
  components?: string;
  registrations?: string;
}

export interface Capability {
  name: string;
  /** Short label for the interactive multiselect. */
  label: string;
  /** Templates this capability is valid for. */
  templates: readonly TemplateName[];
  /** Deps merged into the scaffolded package.json (values may use {{version}}). */
  deps: Record<string, string>;
  /** Per-template wiring injected at application.ts anchors. */
  wire?: Partial<Record<TemplateName, Wiring>>;
  /** Custom mutation hook (used by `console`, which removes deps + swaps files). */
  apply?(ctx: CapabilityContext): void;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/capabilities.js → ../templates/_capabilities */
export function capabilitiesRoot(): string {
  return path.resolve(HERE, '..', 'templates', '_capabilities');
}

/** Merge deps into the scaffolded package.json, preserving order, console deps first. */
function mergeDeps(dir: string, deps: Record<string, string>): void {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  pkg.dependencies = {...(pkg.dependencies ?? {}), ...deps};
  // Keep @agentback/* deps sorted together for readability.
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

/** Copy `_capabilities/<name>/<sub>` into the app dir if it exists. */
function copyOverlay(capRoot: string, name: string, sub: string, dir: string): void {
  const src = path.join(capRoot, name, sub);
  if (existsSync(src)) cpSync(src, dir, {recursive: true});
}

/** ---- the registry ---- */

export const CAPABILITIES: readonly Capability[] = [
  {
    name: 'console',
    label: 'Dev console at /console',
    templates: ['hybrid', 'rest'],
    deps: {'@agentback/console': '{{version}}'},
    apply(ctx) {
      // Console is special: it REMOVES the standalone explorer deps and swaps
      // main.ts. Mirrors the legacy retargetDepsToConsole/main.console behavior.
      const pkgPath = path.join(ctx.dir, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const drop =
        ctx.template === 'hybrid'
          ? ['@agentback/rest-explorer', '@agentback/mcp-inspector']
          : ['@agentback/rest-explorer'];
      for (const k of drop) delete pkg.dependencies?.[k];
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    },
  },
  {
    name: 'drizzle',
    label: 'Drizzle ORM (example table + route/tool)',
    templates: ['hybrid', 'rest', 'mcp'],
    deps: {
      '@agentback/drizzle': '{{version}}',
      'drizzle-orm': '^0.45.2',
      'drizzle-zod': '^0.8.3',
    },
    wire: {
      rest: {
        imports: "import {UsersController} from './controllers/users.controller.js';\nimport {USER_STORE, InMemoryUserStore} from './stores/user-store.js';\nimport {BindingScope} from '@agentback/core';",
        components: 'this.bind(USER_STORE).toClass(InMemoryUserStore).inScope(BindingScope.SINGLETON);',
        registrations: 'this.restController(UsersController);',
      },
      hybrid: {
        imports: "import {UsersController} from './controllers/users.controller.js';\nimport {USER_STORE, InMemoryUserStore} from './stores/user-store.js';\nimport {BindingScope} from '@agentback/core';",
        components: 'this.bind(USER_STORE).toClass(InMemoryUserStore).inScope(BindingScope.SINGLETON);',
        registrations: 'this.restController(UsersController);\n    this.service(UsersController);',
      },
      mcp: {
        imports: "import {UsersTools} from './tools/users.tools.js';\nimport {USER_STORE, InMemoryUserStore} from './stores/user-store.js';\nimport {BindingScope} from '@agentback/core';",
        components: 'this.bind(USER_STORE).toClass(InMemoryUserStore).inScope(BindingScope.SINGLETON);',
        registrations: 'this.service(UsersTools);',
      },
    },
  },
  {
    name: 'auth',
    label: 'JWT authentication (protected example route)',
    templates: ['hybrid', 'rest'],
    deps: {
      '@agentback/authentication': '{{version}}',
      '@agentback/authentication-jwt': '{{version}}',
      jsonwebtoken: '^9.0.2',
    },
    wire: {
      rest: {
        imports: "import {AuthController} from './controllers/auth.controller.js';\nimport {JWTAuthenticationComponent, JWTBindings} from '@agentback/authentication-jwt';",
        components: "this.bind(JWTBindings.SECRET).to(process.env.JWT_SECRET ?? 'dev-secret-change-me');\n    this.bind(JWTBindings.EXPIRES_IN).to('1h');\n    this.component(JWTAuthenticationComponent);",
        registrations: 'this.restController(AuthController);',
      },
      hybrid: {
        imports: "import {AuthController} from './controllers/auth.controller.js';\nimport {JWTAuthenticationComponent, JWTBindings} from '@agentback/authentication-jwt';",
        components: "this.bind(JWTBindings.SECRET).to(process.env.JWT_SECRET ?? 'dev-secret-change-me');\n    this.bind(JWTBindings.EXPIRES_IN).to('1h');\n    this.component(JWTAuthenticationComponent);",
        registrations: 'this.restController(AuthController);',
      },
    },
  },
];

export function capabilityNames(template: TemplateName): string[] {
  return CAPABILITIES.filter(c => c.templates.includes(template)).map(c => c.name);
}

export function findCapability(name: string): Capability | undefined {
  return CAPABILITIES.find(c => c.name === name);
}

/** Validate, merge deps, copy overlays, and return the wiring for a capability. */
export function applyCapability(
  name: string,
  ctx: CapabilityContext,
): Wiring | undefined {
  const cap = findCapability(name);
  if (!cap) {
    throw new Error(
      `Unknown capability '${name}'. Available: ${CAPABILITIES.map(c => c.name).join(', ')}.`,
    );
  }
  if (!cap.templates.includes(ctx.template)) {
    throw new Error(
      `Capability '${name}' is not supported for the '${ctx.template}' ` +
        `template. Available templates: ${cap.templates.join(', ')}.`,
    );
  }
  mergeDeps(ctx.dir, cap.deps);
  // Overlay files: shared first, then per-template.
  copyOverlay(ctx.capRoot, name, '_shared', ctx.dir);
  copyOverlay(ctx.capRoot, name, ctx.template, ctx.dir);
  cap.apply?.(ctx);
  return cap.wire?.[ctx.template];
}
```

- [ ] **Step 4: Wire the registry into `scaffold.ts`**

In `scaffold.ts`:

1. Add `capabilities?: string[]` to `ScaffoldOptions` (after `host?`):
```ts
  /** Opt-in capability add-ons (e.g. 'drizzle', 'auth', 'console'). */
  capabilities?: string[];
```
2. Add the import at top:
```ts
import {applyCapability, capabilitiesRoot} from './capabilities.js';
```
3. Replace the existing `main.console.ts` / `retargetDepsToConsole` / `retargetReadmeToConsole` block with a normalization that folds `console: true` into the capability list, then applies all capabilities. Insert this BEFORE the host-options block from Task 2:

```ts
  // Normalize the legacy `console: true` flag into the capability list.
  const caps = [...(options.capabilities ?? [])];
  if (options.console && !caps.includes('console')) caps.push('console');

  // Console-capable templates ship a `src/main.console.ts` overlay. Swap it in
  // when console is selected; otherwise drop it.
  const consoleEntry = path.join(dir, 'src', 'main.console.ts');
  if (existsSync(consoleEntry)) {
    if (caps.includes('console')) {
      renameSync(consoleEntry, path.join(dir, 'src', 'main.ts'));
    } else {
      rmSync(consoleEntry);
    }
  }

  // Apply each capability: validate, merge deps, copy overlays, collect wiring.
  const wirings = caps.map(name =>
    applyCapability(name, {dir, template, capRoot: capabilitiesRoot()}),
  );
```
4. Update the host-options/anchor block (from Task 2) to also inject capability wiring. Replace the `if (existsSync(appTsPath))` body with:

```ts
  if (existsSync(appTsPath)) {
    let appTs = readFileSync(appTsPath, 'utf8');
    const restConfig = renderRestConfig(options.host);
    if (restConfig) appTs = fillAnchor(appTs, 'rest-config', restConfig, 'inline');
    for (const w of wirings) {
      if (!w) continue;
      if (w.imports) appTs = fillAnchor(appTs, 'imports', w.imports);
      if (w.components) appTs = fillAnchor(appTs, 'components', w.components);
      if (w.registrations) appTs = fillAnchor(appTs, 'registrations', w.registrations);
    }
    appTs = stripAnchors(appTs);
    writeFileSync(appTsPath, appTs);
  }
```
5. Delete the now-unused `retargetDepsToConsole` and `retargetReadmeToConsole` functions and the `CONSOLE_TEMPLATES` export IF nothing else references them. Keep `CONSOLE_TEMPLATES` only if `cli.ts` still imports it (Task 5 updates cli.ts); simplest path: leave `CONSOLE_TEMPLATES` exported and have the console capability's `templates` reference it. To avoid churn, set in `capabilities.ts`: `templates: ['hybrid', 'rest']` literal (already done above) and remove `CONSOLE_TEMPLATES` from `scaffold.ts` after confirming Task 5 drops its cli.ts usage.

> Note: the `imports` anchor sits at the very top of the file (line 1). `fillAnchor` re-emits it, so multiple capabilities stack their imports there; `stripAnchors` removes the final leftover.

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm -F create-agentback build
pnpm exec vitest run packages/create-agentback/dist/__tests__/capabilities.test.js
```
Expected: PASS (all registry + console tests).

- [ ] **Step 6: Commit**

```bash
git add packages/create-agentback/src/capabilities.ts packages/create-agentback/src/scaffold.ts packages/create-agentback/src/__tests__/capabilities.test.ts
git commit -m "feat(create-agentback): capability registry; refactor --console into it"
```

---

## Task 4: Drizzle capability overlay files

**Files:**
- Create: `templates/_capabilities/drizzle/_shared/src/db/schema.ts`
- Create: `templates/_capabilities/drizzle/_shared/src/stores/user-store.ts`
- Create: `templates/_capabilities/drizzle/_shared/.env.example`
- Create: `templates/_capabilities/drizzle/rest/src/controllers/users.controller.ts`
- Create: `templates/_capabilities/drizzle/hybrid/src/controllers/users.controller.ts`
- Create: `templates/_capabilities/drizzle/mcp/src/tools/users.tools.ts`
- Test: `packages/create-agentback/src/__tests__/capabilities.test.ts`

The store is in-memory so the scaffold runs in CI with no database (matching `examples/hello-drizzle`). Template `src/*.ts` overlay files omit the license header to match existing template files.

- [ ] **Step 1: Write the failing test (append to `capabilities.test.ts`)**

```ts
describe('drizzle capability', () => {
  it('adds drizzle deps + schema + controller for hybrid', () => {
    const {dir} = scaffold({
      name: 'dz',
      template: 'hybrid',
      cwd,
      capabilities: ['drizzle'],
    });
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@agentback/drizzle']).toBeDefined();
    expect(pkg.dependencies['drizzle-orm']).toBe('^0.45.2');
    expect(appFile(dir, 'src/db/schema.ts')).toContain('pgTable');
    expect(appFile(dir, 'src/controllers/users.controller.ts')).toContain('@mcpServer');
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).toContain('this.restController(UsersController)');
    expect(appTs).toContain('this.service(UsersController)');
    expect(appTs).toContain('USER_STORE');
    expect(appTs).not.toContain('{{agentback:');
  });

  it('uses a tool-only controller for the mcp template', () => {
    const {dir} = scaffold({
      name: 'dzm',
      template: 'mcp',
      cwd,
      capabilities: ['drizzle'],
    });
    expect(appFile(dir, 'src/tools/users.tools.ts')).toContain('@tool');
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).toContain('this.service(UsersTools)');
    expect(appTs).not.toContain('restController');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F create-agentback build
pnpm exec vitest run packages/create-agentback/dist/__tests__/capabilities.test.js
```
Expected: FAIL — overlay files missing (`ENOENT` on `src/db/schema.ts`).

- [ ] **Step 3: Create `_shared/src/db/schema.ts`**

```ts
// Single source of truth: ONE table feeds drizzle-zod, and the resulting Zod
// schemas drive the row type, the runtime validator, the OpenAPI document, and
// the MCP tool schema. No second source, no codegen.

import {pgTable, serial, text, timestamp} from 'drizzle-orm/pg-core';
import {createInsertSchema, createSelectSchema} from '@agentback/drizzle/zod';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Insert shape: id + createdAt have defaults, so they're optional on insert. */
export const NewUser = createInsertSchema(users);

/** Select shape: the full persisted row. */
export const User = createSelectSchema(users);
```

- [ ] **Step 4: Create `_shared/src/stores/user-store.ts`**

```ts
// The controller injects a small data-access PORT, not a live DB driver — this
// keeps the scaffold runnable in CI with zero database. Swap InMemoryUserStore
// for a Postgres-backed store via `registerDrizzle` + `DrizzleBindings.CLIENT`
// (see README) when you wire up a real database.

import {BindingKey} from '@agentback/core';
import {z} from 'zod';
import {NewUser, User} from '../db/schema.js';

export type NewUser = z.infer<typeof NewUser>;
export type User = z.infer<typeof User>;

export interface UserStore {
  create(input: NewUser): Promise<User>;
}

export const USER_STORE = BindingKey.create<UserStore>('stores.UserStore');

export class InMemoryUserStore implements UserStore {
  private nextId = 1;
  private readonly rows: User[] = [];

  async create(input: NewUser): Promise<User> {
    const row: User = {
      id: input.id ?? this.nextId++,
      email: input.email,
      name: input.name,
      createdAt: input.createdAt ?? new Date(),
    };
    this.rows.push(row);
    return row;
  }
}
```

- [ ] **Step 5: Create `_shared/.env.example`**

```
# Drizzle: set this when you swap InMemoryUserStore for a Postgres-backed store.
DATABASE_URL=postgres://user:pass@localhost:5432/{{name}}
```

- [ ] **Step 6: Create `rest/src/controllers/users.controller.ts`**

```ts
import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, post} from '@agentback/openapi';
import {NewUser, User} from '../db/schema.js';
import {USER_STORE, type UserStore} from '../stores/user-store.js';

@api({basePath: '/users'})
export class UsersController {
  constructor(@inject(USER_STORE) private store: UserStore) {}

  @post('/', {body: NewUser, response: User, status: 201})
  async create(input: {
    body: z.infer<typeof NewUser>;
  }): Promise<z.infer<typeof User>> {
    return this.store.create(input.body);
  }
}
```

- [ ] **Step 7: Create `hybrid/src/controllers/users.controller.ts`** (dual REST + MCP)

```ts
import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, post} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';
import {NewUser, User} from '../db/schema.js';
import {USER_STORE, type UserStore} from '../stores/user-store.js';

// One controller, one schema pair, two protocols. The SAME table-derived Zod
// schemas drive POST /users (REST + OpenAPI) and the create_user MCP tool.
@api({basePath: '/users'})
@mcpServer()
export class UsersController {
  constructor(@inject(USER_STORE) private store: UserStore) {}

  @post('/', {body: NewUser, response: User, status: 201})
  async create(input: {
    body: z.infer<typeof NewUser>;
  }): Promise<z.infer<typeof User>> {
    return this.store.create(input.body);
  }

  @tool('create_user', {
    description: 'Create a user. Same schema chain as POST /users.',
    input: NewUser,
    output: User,
  })
  async createUser(
    input: z.infer<typeof NewUser>,
  ): Promise<z.infer<typeof User>> {
    return this.store.create(input);
  }
}
```

- [ ] **Step 8: Create `mcp/src/tools/users.tools.ts`** (tool-only)

```ts
import {z} from 'zod';
import {inject} from '@agentback/core';
import {mcpServer, tool} from '@agentback/mcp';
import {NewUser, User} from '../db/schema.js';
import {USER_STORE, type UserStore} from '../stores/user-store.js';

@mcpServer()
export class UsersTools {
  constructor(@inject(USER_STORE) private store: UserStore) {}

  @tool('create_user', {
    description: 'Create a user from the table-derived Zod schema.',
    input: NewUser,
    output: User,
  })
  async createUser(
    input: z.infer<typeof NewUser>,
  ): Promise<z.infer<typeof User>> {
    return this.store.create(input);
  }
}
```

- [ ] **Step 9: Run tests to verify they pass**

```bash
pnpm -F create-agentback build
pnpm exec vitest run packages/create-agentback/dist/__tests__/capabilities.test.js
```
Expected: PASS (drizzle tests).

- [ ] **Step 10: Commit**

```bash
git add packages/create-agentback/templates/_capabilities/drizzle
git commit -m "feat(create-agentback): drizzle capability overlay (table + store + route/tool)"
```

---

## Task 5: Auth (JWT) capability overlay files

**Files:**
- Create: `templates/_capabilities/auth/_shared/src/controllers/auth.controller.ts`
- Create: `templates/_capabilities/auth/_shared/.env.example`
- Test: `packages/create-agentback/src/__tests__/capabilities.test.ts`

- [ ] **Step 1: Write the failing test (append to `capabilities.test.ts`)**

```ts
describe('auth capability', () => {
  it('adds jwt deps + auth controller + component wiring for rest', () => {
    const {dir} = scaffold({
      name: 'au',
      template: 'rest',
      cwd,
      capabilities: ['auth'],
    });
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@agentback/authentication-jwt']).toBeDefined();
    expect(pkg.dependencies['jsonwebtoken']).toBe('^9.0.2');
    expect(appFile(dir, 'src/controllers/auth.controller.ts')).toContain('@authenticate');
    const appTs = appFile(dir, 'src/application.ts');
    expect(appTs).toContain('JWTAuthenticationComponent');
    expect(appTs).toContain('this.restController(AuthController)');
    expect(appTs).not.toContain('{{agentback:');
  });

  it('rejects auth for the mcp template', () => {
    expect(() =>
      scaffold({name: 'x', template: 'mcp', cwd, capabilities: ['auth']}),
    ).toThrow(/auth.*mcp/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm -F create-agentback build
pnpm exec vitest run packages/create-agentback/dist/__tests__/capabilities.test.js
```
Expected: FAIL — `auth.controller.ts` missing.

- [ ] **Step 3: Create `auth/_shared/src/controllers/auth.controller.ts`**

```ts
import {z} from 'zod';
import {inject} from '@agentback/core';
import {get, post} from '@agentback/openapi';
import {authenticate} from '@agentback/authentication';
import {JWTBindings, JWTService} from '@agentback/authentication-jwt';
import {securityId, type UserProfile} from '@agentback/security';

const LoginIn = z.object({username: z.string().min(1), password: z.string().min(1)});
const TokenOut = z.object({token: z.string()});
const MeOut = z.object({id: z.string(), name: z.string().optional()});

// Issues JWTs at POST /auth/login and exposes a JWT-protected GET /auth/me.
// Replace the credential check with your real user lookup.
export class AuthController {
  constructor(@inject(JWTBindings.SERVICE) private jwt: JWTService) {}

  @post('/auth/login', {body: LoginIn, response: TokenOut})
  async login(input: {body: z.infer<typeof LoginIn>}): Promise<z.infer<typeof TokenOut>> {
    // DEMO ONLY: accept any non-empty credentials. Verify real credentials here.
    const profile: UserProfile = {
      [securityId]: `user-${input.body.username}`,
      name: input.body.username,
    };
    return {token: await this.jwt.generateToken(profile)};
  }

  @authenticate('jwt')
  @get('/auth/me', {response: MeOut})
  async me(
    @inject(securityId, {optional: true}) userId?: string,
  ): Promise<z.infer<typeof MeOut>> {
    return {id: userId ?? 'unknown'};
  }
}
```

> If `@inject(securityId, ...)` does not resolve the current user id in this framework version, fall back to injecting the full profile via the authentication binding key documented in `packages/authentication/README.md`. Verify during implementation (Step 5) — the test only asserts the `@authenticate` decorator is present and the app builds, so adjust the `me()` body to whatever compiles against the current API.

- [ ] **Step 4: Create `auth/_shared/.env.example`**

```
# JWT signing secret. CHANGE THIS in any non-local environment.
JWT_SECRET=dev-secret-change-me
```

- [ ] **Step 5: Build + run tests + verify the auth controller compiles**

```bash
pnpm -F create-agentback build
pnpm exec vitest run packages/create-agentback/dist/__tests__/capabilities.test.js
```
Expected: PASS (auth tests). The full compile-against-framework check happens in Task 7 (validate-templates). If `securityId` injection doesn't compile there, fix `me()` per the Step 3 note and re-run.

- [ ] **Step 6: Commit**

```bash
git add packages/create-agentback/templates/_capabilities/auth
git commit -m "feat(create-agentback): auth (jwt) capability overlay (login + protected route)"
```

---

## Task 6: CLI flags + interactive mode (`@clack/prompts`)

**Files:**
- Modify: `packages/create-agentback/package.json`
- Modify: `packages/create-agentback/src/cli.ts`

- [ ] **Step 1: Add `@clack/prompts` dependency**

Edit `packages/create-agentback/package.json` — add a `dependencies` block (the package currently has none):

```json
  "dependencies": {
    "@clack/prompts": "^0.11.0"
  },
```

Then install:

```bash
pnpm install
```
Expected: resolves cleanly. If pnpm 11 rejects it for the supply-chain age policy (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`), pin one patch older and note why in the commit.

- [ ] **Step 2: Rewrite `cli.ts` with new flags + interactive mode**

Replace `packages/create-agentback/src/cli.ts` with:

```ts
#!/usr/bin/env node
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import * as p from '@clack/prompts';
import {
  detectPackageManager,
  scaffold,
  TEMPLATES,
  type ScaffoldOptions,
  type TemplateName,
} from './scaffold.js';
import {CAPABILITIES, capabilityNames} from './capabilities.js';

const CAP_NAMES = CAPABILITIES.map(c => c.name);

const USAGE = `create-agentback — scaffold an AgentBack app

Usage:
  npm create agentback <name> [-- --template ${TEMPLATES.join('|')}] [options]
  pnpm create agentback <name> [--template ${TEMPLATES.join('|')}] [options]

  Run with no name on a terminal for interactive mode.

Options:
  -t, --template <name>   Template: ${TEMPLATES.join(', ')} (default: hybrid)
  --with <caps>           Comma-separated capabilities: ${CAP_NAMES.join(', ')}
  --drizzle               Shorthand for --with drizzle
  --auth                  Shorthand for --with auth
  -c, --console           Shorthand for --with console
  --port <n>              REST server port (rest|hybrid)
  --host <h>              REST server host (rest|hybrid)
  --base-path <p>         REST base path (rest|hybrid)
  -h, --help              Show this help
`;

function fail(msg: string): never {
  console.error(`error: ${msg}\n`);
  console.error(USAGE);
  process.exit(1);
}

const args = process.argv.slice(2);
let name: string | undefined;
let template: TemplateName | undefined;
const caps = new Set<string>();
const host: {port?: number; host?: string; basePath?: string} = {};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '-t' || a === '--template') {
    template = args[++i] as TemplateName;
  } else if (a.startsWith('--template=')) {
    template = a.slice('--template='.length) as TemplateName;
  } else if (a === '--with') {
    for (const c of (args[++i] ?? '').split(',').filter(Boolean)) caps.add(c);
  } else if (a.startsWith('--with=')) {
    for (const c of a.slice('--with='.length).split(',').filter(Boolean)) caps.add(c);
  } else if (a === '--drizzle') {
    caps.add('drizzle');
  } else if (a === '--auth') {
    caps.add('auth');
  } else if (a === '-c' || a === '--console') {
    caps.add('console');
  } else if (a === '--port') {
    host.port = Number(args[++i]);
  } else if (a === '--host') {
    host.host = args[++i];
  } else if (a === '--base-path') {
    host.basePath = args[++i];
  } else if (a.startsWith('-')) {
    fail(`unknown option '${a}'`);
  } else if (!name) {
    name = a;
  } else {
    fail(`unexpected argument '${a}'`);
  }
}

if (host.port !== undefined && Number.isNaN(host.port)) {
  fail('--port must be a number');
}

async function interactive(): Promise<void> {
  p.intro('create-agentback');

  const iName = await p.text({
    message: 'App name',
    placeholder: 'my-service',
    validate: v => (v && v.trim() ? undefined : 'Name is required'),
  });
  if (p.isCancel(iName)) return cancel();
  name = iName.trim();

  const iTemplate = await p.select({
    message: 'Template',
    options: TEMPLATES.map(t => ({value: t, label: t})),
    initialValue: 'hybrid' as TemplateName,
  });
  if (p.isCancel(iTemplate)) return cancel();
  template = iTemplate as TemplateName;

  const available = capabilityNames(template);
  if (available.length) {
    const iCaps = await p.multiselect({
      message: 'Add-ons (space to toggle, enter to confirm)',
      required: false,
      options: CAPABILITIES.filter(c => available.includes(c.name)).map(c => ({
        value: c.name,
        label: c.label,
      })),
    });
    if (p.isCancel(iCaps)) return cancel();
    for (const c of iCaps as string[]) caps.add(c);
  }

  if (template === 'rest' || template === 'hybrid') {
    const iPort = await p.text({
      message: 'Port (blank for default 3000)',
      placeholder: '3000',
      validate: v => (!v || /^\d+$/.test(v) ? undefined : 'Port must be a number'),
    });
    if (p.isCancel(iPort)) return cancel();
    if (iPort) host.port = Number(iPort);
  }

  const ok = await p.confirm({message: `Scaffold '${name}' (${template})?`});
  if (p.isCancel(ok) || !ok) return cancel();
}

function cancel(): never {
  p.cancel('Cancelled.');
  process.exit(0);
}

async function run(): Promise<void> {
  // Interactive only when no name AND a TTY. Flags already collected win.
  if (!name && process.stdin.isTTY) {
    await interactive();
  }
  if (!name) fail('missing app name');

  const opts: ScaffoldOptions = {
    name,
    template,
    capabilities: [...caps],
    host: Object.keys(host).length ? host : undefined,
  };

  try {
    const result = scaffold(opts);
    const pm = detectPackageManager();
    const runCmd = pm === 'npm' ? 'npm run' : pm;
    const dirName = name.includes('/') ? name.split('/')[1] : name;
    console.log(
      `\nScaffolded '${name}' (${result.template} template) in ${result.dir}\n`,
    );
    if (caps.size) console.log(`Add-ons: ${[...caps].join(', ')}\n`);
    console.log('Next steps:');
    console.log(`  cd ${dirName}`);
    console.log(`  ${pm} install`);
    console.log(`  ${runCmd} build && ${pm === 'npm' ? 'npm start' : `${pm} start`}`);
    console.log(`  ${pm} test\n`);
    if (caps.has('drizzle')) {
      console.log('Drizzle: copy .env.example → .env and set DATABASE_URL for Postgres.\n');
    }
    if (caps.has('auth')) {
      console.log('Auth: set JWT_SECRET in .env before deploying.\n');
    }
  } catch (err) {
    fail((err as Error).message);
  }
}

await run();
```

- [ ] **Step 3: Build and smoke-test the help + a non-interactive scaffold**

```bash
pnpm -F create-agentback build
node packages/create-agentback/dist/cli.js --help
node packages/create-agentback/dist/cli.js smoke-app --template rest --drizzle --port 8080 < /dev/null
```
Expected: help shows both npm/pnpm forms + new options; the second command scaffolds `smoke-app/` (note `< /dev/null` makes stdin non-TTY so interactive mode is skipped). Then clean up:

```bash
rm -rf smoke-app
```

- [ ] **Step 4: Run the full package test suite**

```bash
pnpm exec vitest run packages/create-agentback/dist/__tests__
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/create-agentback/package.json packages/create-agentback/src/cli.ts pnpm-lock.yaml
git commit -m "feat(create-agentback): capability flags + @clack/prompts interactive mode"
```

---

## Task 7: Extend validate-templates with a capability combo + docs

**Files:**
- Modify: `scripts/validate-templates.mjs`
- Modify: `packages/create-agentback/README.md` (if present)

- [ ] **Step 1: Read the current matrix section**

```bash
sed -n '25,120p' scripts/validate-templates.mjs
```
Note how `apps` is built and how each app is scaffolded + deps rewritten to `workspace:*`. The combo app must rewrite the NEW capability deps (`drizzle-orm`, `drizzle-zod`, `jsonwebtoken`) to real versions too — those are public npm deps, not `@agentback/*`, so the existing `workspace:*` rewrite (which only touches `@agentback/*`) already leaves them intact. Confirm the rewrite only retargets `@agentback/*`.

- [ ] **Step 2: Add a combo app to the matrix**

Change the `apps` construction so it also scaffolds a hybrid app with `--drizzle --auth`. Replace the `const apps = TEMPLATES.map(...)` block with:

```js
const apps = [
  ...TEMPLATES.map(t => ({
    template: t,
    name: `tmpl-check-${t}`,
    dir: join(ROOT, 'examples', `tmpl-check-${t}`),
    extraArgs: [],
  })),
  {
    template: 'hybrid',
    name: 'tmpl-check-caps',
    dir: join(ROOT, 'examples', 'tmpl-check-caps'),
    extraArgs: ['--drizzle', '--auth'],
  },
];
```

Then find the scaffold invocation (the `run(...)` call that runs the CLI) and append `...app.extraArgs` to its argument array. For example if it currently reads:

```js
run('node', [CLI, app.name, '--template', app.template], ...);
```
change it to:

```js
run('node', [CLI, app.name, '--template', app.template, ...app.extraArgs], ...);
```

- [ ] **Step 3: Run validate-templates**

```bash
pnpm build
node scripts/validate-templates.mjs
```
Expected: all base templates + the `tmpl-check-caps` combo scaffold, build, and test green. If the auth `me()` route fails to compile, fix it per the Task 5 / Step 3 note and re-run. Script self-cleans temp apps + restores the lockfile.

- [ ] **Step 4: Document the new flags in the README**

If `packages/create-agentback/README.md` exists, add a section after the usage:

````markdown
## Capabilities

Add runnable integrations at scaffold time:

```bash
npm create agentback my-api -- --template hybrid --drizzle --auth
pnpm create agentback my-api --template hybrid --drizzle --auth
```

| Flag        | Templates      | Adds                                                        |
| ----------- | -------------- | ---------------------------------------------------------- |
| `--drizzle` | all            | Example `users` table + store + REST route / MCP tool      |
| `--auth`    | rest, hybrid   | JWT login + a `@authenticate('jwt')`-protected route       |
| `--console` | rest, hybrid   | Unified dev console at `/console`                          |

## HTTP host options (rest, hybrid)

```bash
npm create agentback my-api -- --port 8080 --host 0.0.0.0 --base-path /api
```

## Interactive mode

Run with no app name in a terminal to be prompted for everything:

```bash
npm create agentback
```
````

If no README exists, skip this step (the `--help` text already documents the flags).

- [ ] **Step 5: Commit**

```bash
git add scripts/validate-templates.mjs packages/create-agentback/README.md
git commit -m "test(create-agentback): validate drizzle+auth combo; document capability flags"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the full local CI mirror**

```bash
pnpm verify
```
Expected: `build` + `typecheck:client` + `test` + `validate-templates` all green. (Note: `pnpm verify` includes `validate-templates`, so it re-runs Task 7's combo.)

- [ ] **Step 2: Lint**

```bash
pnpm lint
```
Expected: clean. Run `pnpm lint:fix` if prettier/eslint flags formatting in the new files.

- [ ] **Step 3: Final commit (only if lint:fix changed anything)**

```bash
git add -A
git commit -m "chore(create-agentback): lint"
```

---

## Self-review notes

- **Spec coverage:** registry (Task 3), anchors (Tasks 1–2), drizzle runnable wiring (Task 4), auth jwt runnable wiring (Task 5), interactive mode (Task 6), host options (Task 2 + 6), `--console` refactor (Task 3), validate-templates combo (Task 7), `@clack/prompts` dep (Task 6) — all covered.
- **Deferred per spec:** rate-limit, files, oauth2, `--cors` — not implemented; registry shape supports adding them later.
- **Type consistency:** `Capability`/`CapabilityContext`/`Wiring` defined once in Task 3 and used by Tasks 4–6; `ScaffoldOptions.host`/`.capabilities` added in Tasks 2–3 and consumed in Task 6; overlay export names (`UsersController`, `UsersTools`, `USER_STORE`, `InMemoryUserStore`, `AuthController`) match the wiring strings in the registry.
- **Known verification point:** the auth `me()` route's current-user injection (`securityId`) is the one API detail not proven against an example; Task 5/Step 3 + Task 7 are the gates that confirm or correct it.
