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
  /** Custom mutation hook (used by `console`, which removes deps + retargets docs). */
  apply?(ctx: CapabilityContext): void;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** dist/capabilities.js -> ../templates/_capabilities */
export function capabilitiesRoot(): string {
  return path.resolve(HERE, '..', 'templates', '_capabilities');
}

/** Merge deps into the scaffolded package.json, keeping deps sorted. */
function mergeDeps(dir: string, deps: Record<string, string>): void {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  pkg.dependencies = {...(pkg.dependencies ?? {}), ...deps};
  pkg.dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

/** Copy `_capabilities/<name>/<sub>` into the app dir if it exists. */
function copyOverlay(
  capRoot: string,
  name: string,
  sub: string,
  dir: string,
): void {
  const src = path.join(capRoot, name, sub);
  if (existsSync(src)) cpSync(src, dir, {recursive: true});
}

/** Point the README's URL hints at /console instead of the explorers. */
function retargetReadmeToConsole(dir: string): void {
  const readmePath = path.join(dir, 'README.md');
  if (!existsSync(readmePath)) return;
  const text = readFileSync(readmePath, 'utf8')
    .replace('REST + Swagger UI at /explorer', 'REST + dev console at /console')
    .replace(
      '`GET /explorer` (Swagger UI) · `GET /mcp-inspector` · `POST /mcp` (MCP HTTP)',
      '`GET /console` (dev console) · `POST /mcp` (MCP HTTP)',
    );
  writeFileSync(readmePath, text);
}

/** ---- the registry ---- */

export const CAPABILITIES: readonly Capability[] = [
  {
    name: 'console',
    label: 'Dev console at /console',
    templates: ['hybrid', 'rest'],
    deps: {'@agentback/console': '{{version}}'},
    apply(ctx) {
      // Console REMOVES the standalone explorer deps and retargets the README.
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
      retargetReadmeToConsole(ctx.dir);
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
        imports:
          "import {UsersController} from './controllers/users.controller.js';\nimport {USER_STORE, InMemoryUserStore} from './stores/user-store.js';\nimport {BindingScope} from '@agentback/core';",
        components:
          'this.bind(USER_STORE).toClass(InMemoryUserStore).inScope(BindingScope.SINGLETON);',
        registrations: 'this.restController(UsersController);',
      },
      hybrid: {
        imports:
          "import {UsersController} from './controllers/users.controller.js';\nimport {USER_STORE, InMemoryUserStore} from './stores/user-store.js';\nimport {BindingScope} from '@agentback/core';",
        components:
          'this.bind(USER_STORE).toClass(InMemoryUserStore).inScope(BindingScope.SINGLETON);',
        registrations:
          'this.restController(UsersController);\n    this.service(UsersController);',
      },
      mcp: {
        imports:
          "import {UsersTools} from './tools/users.tools.js';\nimport {USER_STORE, InMemoryUserStore} from './stores/user-store.js';\nimport {BindingScope} from '@agentback/core';",
        components:
          'this.bind(USER_STORE).toClass(InMemoryUserStore).inScope(BindingScope.SINGLETON);',
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
      '@agentback/security': '{{version}}',
      jsonwebtoken: '^9.0.2',
    },
    wire: {
      rest: {
        imports:
          "import {AuthController} from './controllers/auth.controller.js';\nimport {JWTAuthenticationComponent, JWTBindings} from '@agentback/authentication-jwt';",
        components:
          "this.bind(JWTBindings.SECRET).to(process.env.JWT_SECRET ?? 'dev-secret-change-me');\n    this.bind(JWTBindings.EXPIRES_IN).to('1h');\n    this.component(JWTAuthenticationComponent);",
        registrations: 'this.restController(AuthController);',
      },
      hybrid: {
        imports:
          "import {AuthController} from './controllers/auth.controller.js';\nimport {JWTAuthenticationComponent, JWTBindings} from '@agentback/authentication-jwt';",
        components:
          "this.bind(JWTBindings.SECRET).to(process.env.JWT_SECRET ?? 'dev-secret-change-me');\n    this.bind(JWTBindings.EXPIRES_IN).to('1h');\n    this.component(JWTAuthenticationComponent);",
        registrations: 'this.restController(AuthController);',
      },
    },
  },
];

export function capabilityNames(template: TemplateName): string[] {
  return CAPABILITIES.filter(c => c.templates.includes(template)).map(
    c => c.name,
  );
}

export function findCapability(name: string): Capability | undefined {
  return CAPABILITIES.find(c => c.name === name);
}

/** Validate, merge deps, copy overlays, run custom apply, return the wiring. */
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
  copyOverlay(ctx.capRoot, name, '_shared', ctx.dir);
  copyOverlay(ctx.capRoot, name, ctx.template, ctx.dir);
  cap.apply?.(ctx);
  return cap.wire?.[ctx.template];
}
