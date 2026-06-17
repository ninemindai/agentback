# create-agentback CLI enhancements — design

**Date:** 2026-06-16
**Status:** Approved (design); ready for implementation plan
**Package:** `create-agentback`

## Summary

Extend the existing `create-agentback` scaffolder with three capabilities:

1. **Interactive prompts** — when run without an app name on a TTY, drive the user
   through name → template → add-ons → host options via `@clack/prompts`.
2. **Capability flags** — opt-in add-ons (`--drizzle`, `--auth`) that produce
   **runnable wiring** (deps + overlay files + `application.ts` wiring + a working
   example), built on a declarative capability registry rather than ad-hoc
   `if` branches.
3. **HTTP host options** — `--port`, `--host`, `--base-path` baked into the
   scaffolded `application.ts`.

Non-goals (deliberately deferred, but the architecture must accommodate them):
`rate-limit` and `files` capabilities, `oauth2` auth, a `--cors` flag, and any
post-scaffold codegen (`agentback generate ...`).

## Motivation

The CLI today (`packages/create-agentback/src/cli.ts` + `scaffold.ts`) supports
three templates (`hybrid`/`rest`/`mcp`) and one capability flag (`--console`).
Two gaps:

- **No interactive mode.** Running with no args calls `fail()` with usage text.
  `npm create` / `pnpm create` users expect a wizard when they pass nothing.
- **No capability composition.** The framework ships 30+ capability packages,
  but a user can only scaffold the three base templates; adding Drizzle or auth
  is manual integration work.

`--console` is already a de-facto capability flag, implemented as post-copy
mutation hardcoded inside `scaffold()` (`retargetDepsToConsole`,
`retargetReadmeToConsole`, `main.console.ts` swap). Adding more flags in that
style turns `scaffold()` into a pile of special cases. This design refactors
`--console` into a general registry so new capabilities are additive.

## Architecture

### Capability registry (new: `src/capabilities.ts`)

One declarative entry per capability. `scaffold()` consults the registry instead
of branching per-flag.

```ts
interface Capability {
  /** Flag/identifier, e.g. 'drizzle'. */
  name: string;
  /** Short label shown in interactive multiselect. */
  label: string;
  /** Templates this capability is valid for. */
  templates: readonly TemplateName[];
  /** Deps merged into the scaffolded package.json (values may use {{version}}). */
  deps: Record<string, string>;
  /**
   * Mutate the scaffolded app: copy overlay files from
   * templates/_capabilities/<name>/ and fill the named anchors in
   * application.ts / main.ts. Pure file I/O against `dir`.
   */
  apply(dir: string, ctx: CapabilityContext): void;
}

interface CapabilityContext {
  name: string;          // app name
  template: TemplateName;
  version: string;       // resolved @agentback/* version range
}
```

`--console` is reimplemented as a registry entry (`templates: ['hybrid','rest']`),
so the "capability × template" compatibility rule lives in exactly one place.

### Anchor-based wiring (not regex-on-user-code)

Base templates ship **named anchor comments** that capabilities fill. Wiring is
deterministic and testable; we never regex arbitrary code.

`application.ts` anchors (in the base templates):

```ts
export class Application extends RestApplication {
  constructor() {
    super({/* {{agentback:rest-config}} */});
    this.component(MCPComponent);
    // {{agentback:components}}
    this.restController(GreetingController);
    this.service(GreetingController);
    // {{agentback:registrations}}
  }
}
```

- A capability's `apply()` replaces an anchor with `injected code\n  <anchor>`
  (re-emitting the anchor) so multiple capabilities can stack at the same point.
- Host options fill `{{agentback:rest-config}}` with `rest: {port, host, basePath}`.
- After all capabilities run, a final pass strips any unfilled anchor comments so
  the emitted code is clean.

Anchors use the `{{agentback:*}}` namespace, distinct from the existing
`{{name}}`/`{{version}}` substitution tokens, and are NOT matched by the
`SUBSTITUTED` token pass.

### Overlay files

Capability overlay files live in `templates/_capabilities/<name>/` and are copied
into the scaffolded app by `apply()`. They go through the same `{{name}}` /
`{{version}}` substitution as base-template files (the substitution pass walks the
final `dir`, so overlays are covered automatically). Examples:

- `drizzle/` → `src/db/schema.ts` (one example table).
- `auth/` → a protected example controller.

Overlays live **under** `templates/` (at `templates/_capabilities/<name>/`), so
they are already covered by the existing `files: ["dist","templates"]` entry in
`package.json` — no `files` change needed. The base-template copy is driven by the
`TEMPLATES` list (`hybrid`/`rest`/`mcp`), so `_capabilities/` is never mistaken
for a base template.

### Build-now capabilities

**`drizzle`** — `templates: ['hybrid','rest','mcp']`
- deps: `@agentback/drizzle`.
- overlay: `src/db/schema.ts` — one Drizzle table + its `drizzle-zod` schema.
- wiring: register the Drizzle client binding / component at `{{agentback:components}}`;
  add an example route (rest/hybrid) or tool (mcp) that reads the table.
- runtime: needs `DATABASE_URL`; README documents it and `.gitignore`-safe
  `.env.example` is added.

**`auth` (jwt)** — `templates: ['hybrid','rest']`
- deps: `@agentback/authentication`, `@agentback/authentication-jwt`.
- overlay: a protected example controller demonstrating a JWT-guarded route.
- wiring: register the auth component + strategy at `{{agentback:components}}`.
- runtime: README documents the signing secret env var.

### Host options

`--port <n>`, `--host <h>`, `--base-path <p>` collected as
`{port?, host?, basePath?}` and rendered into `{{agentback:rest-config}}` as a
`rest: {...}` object (only keys the user set). Omitted → anchor stripped →
defaults (`3000`/`127.0.0.1`) and runtime `PORT`/`HOST` env precedence preserved.
Rejected for the `mcp` template (stdio, no REST server), same error shape as
`--console`.

### Interactive mode (`src/cli.ts`)

Trigger: **app name omitted AND `process.stdin.isTTY`**. Otherwise the existing
flag-parsing path runs unchanged (CI, scripts, non-TTY pipes keep working).

Flow (via `@clack/prompts`):
1. `text` — app name (validated against the existing `NAME_RE`).
2. `select` — template.
3. `multiselect` — capabilities, filtered to `cap.templates.includes(chosen)`.
4. `text` (optional) — host options (port/host/base-path), shown only for
   REST-capable templates.
5. `confirm` — summary of selections before scaffolding.
6. Handle `isCancel` (Ctrl-C) cleanly → exit 0 with a "cancelled" note.

**Precedence:** explicit flags always win; interactive only fills what flags
left unset. (A user may pass `--template rest` and still be prompted for the
rest.) When a name is supplied as an arg, interactive mode does not trigger.

Prompt logic stays thin in `cli.ts`; `scaffold()` and `capabilities.ts` have no
TTY dependency and remain unit-testable headlessly.

## Data flow

```
cli.ts (argv parse)
  ├─ name present OR non-TTY ─→ use flags as-is
  └─ name absent AND TTY ────→ @clack prompts fill missing fields
        ↓ resolved {name, template, capabilities[], host{}}
scaffold(options)
  1. validate name + template
  2. copy base template → dir
  3. restore .gitignore (existing behavior)
  4. for each capability: validate template compat → merge deps → apply()
  5. fill host options into {{agentback:rest-config}}
  6. strip unfilled {{agentback:*}} anchors
  7. {{name}}/{{version}} substitution pass over dir
  8. return ScaffoldResult
```

`ScaffoldOptions` gains `capabilities?: string[]` and
`host?: {port?: number; host?: string; basePath?: string}`. The existing
`console?: boolean` becomes sugar for `capabilities: [...,'console']` (kept for
back-compat) or is folded into `capabilities` — implementation detail for the
plan; external behavior of `--console` is unchanged.

## Error handling

- Unknown capability flag → `fail()` with the valid list (mirrors existing
  unknown-option handling).
- Capability incompatible with template → throw with the capability + template
  named and the valid templates listed (mirrors the `--console` error).
- Malformed `--port` (non-numeric) → `fail()` with a clear message.
- Interactive `isCancel` → graceful exit, no partial directory left behind.
- Existing non-empty target dir guard is unchanged.

## Testing

- **Unit (`packages/create-agentback/src/__tests__/`):**
  - `scaffold()` per capability: deps merged, overlay files present, anchors
    filled, no leftover `{{agentback:*}}` tokens.
  - Capability + template incompatibility throws.
  - Host options rendered into config; omitted → no `rest:` block.
  - `--console` still behaves identically (regression).
  - Capability combos (e.g. `drizzle` + `auth`) stack at the same anchor.
- **`scripts/validate-templates.mjs`:** add at least one capability combo
  (`hybrid` + `drizzle` + `auth`) to the matrix; scaffold → build → test proves
  runnable wiring isn't stale against current workspace packages.
- **Interactive path:** logic kept thin and behind the TTY check; covered by a
  smoke test that stubs prompt inputs if practical, otherwise excluded from unit
  scope (the headless core carries the coverage).

## Dependencies

- Add `@clack/prompts` to `create-agentback` `dependencies` (ESM-native, small
  transitive footprint). It lands only in the bootstrap tool, never in scaffolded
  apps. Mind the pnpm 11 supply-chain age policy when adding.

## Files touched (anticipated)

- `packages/create-agentback/src/cli.ts` — interactive mode + new flags.
- `packages/create-agentback/src/scaffold.ts` — registry-driven apply + host
  options + anchor stripping; refactor `--console` into the registry.
- `packages/create-agentback/src/capabilities.ts` — **new**, the registry.
- `packages/create-agentback/templates/{hybrid,rest,mcp}/src/application.ts` —
  add anchor comments.
- `packages/create-agentback/templates/_capabilities/{drizzle,auth}/**` — **new**
  overlay files.
- `packages/create-agentback/package.json` — `@clack/prompts` dep.
- `packages/create-agentback/src/__tests__/**` — new/expanded tests.
- `scripts/validate-templates.mjs` — capability combo in the matrix.
- README / help text — document new flags + interactive mode.

## Open questions

None blocking. Future extensions (rate-limit, files, oauth2, --cors) are
explicitly out of scope but the registry + anchor design accommodates them
without touching existing branches.
