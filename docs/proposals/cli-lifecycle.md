# Proposal: `agentback` as a lifecycle CLI — `new` / `deploy` / `update`

> **Naming:** this is the **ops** CLI (`@agentback/cli`, bins `agentback`/`abc`),
> not [`@agentback/command`](cli-projection.md), which projects an app's own
> `@tool` classes as an operator CLI. That one turns _your app_ into a command;
> this one _operates on_ your app. The two never overlap.

**Status:** **Design (2026-08-04)** — brainstormed, decisions locked (see
Decisions log). Not yet implemented.

**Relationship to prior art:** extends the existing deploy CLI rather than
introducing a package. Absorbs the `create-agentback` scaffolder as a delegate
(not a merge), and adds the missing third verb: upgrading an app across a
breaking release.

## Thesis

AgentBack already has more CLI surface than the templates it is compared to —
`npm create agentback` composes `template × capability` where a template repo
merely clones a tree, and `agentback deploy vercel|cloudflare` has no analogue
in that class of tool at all. The gap is not creation. It is **the upgrade
path**: lockstep `0.x` versioning means every minor bump is manual multi-file
toil, and every breaking change is undocumented.

One binary should cover the lifecycle — create, deploy, upgrade — and the
upgrade verb should be honest that most breaking changes cannot be codemodded.

## Motivation

Three findings from the current repo, each of which shaped a decision below.

**1. The bump is real toil that `npm update` cannot do.** The `hybrid` template
ships 8 `@agentback/*` entries (7 `dependencies` + `@agentback/testing` in
`devDependencies`). Under `0.x` semver a caret range `^0.9.0` resolves to
`>=0.9.0 <0.10.0`, so moving to `0.10` requires hand-editing every entry.
Lockstep releases guarantee they all move together, which makes this both
high-frequency and mechanically trivial — the best possible automation target.

**2. Released breaking changes are config-shaped, not source-shaped.** Every
breaking change in a tagged release landed in **v0.9.0**:

| Commit     | Change                                                   | Shape           |
| ---------- | -------------------------------------------------------- | --------------- |
| `9308a3cd` | serve the 2026-07-28 revision by default (S7a)           | config/behavior |
| `f746061b` | close two stateless-default holes (scope, confirmation)  | behavior        |
| `1b6290be` | validate `Origin` by default; stop debiting doomed reqs  | config/behavior |

The two genuinely source-mechanical API changes in project history —
`3c68d465` (`@arg` → object-style tool input) and `24ead7cc` (method-level Zod
schemas; `@inject` to slots 1+) — are dated 2026-05-18 and are **not ancestors
of `main`**; they sit on branches rebased away a month before the first tag
(`v0.5.1`, 2026-06-18). **No published version ever shipped those APIs.**

A codemod-only `update` would therefore have transformed nothing, ever. The
registry has to treat "detect and explain" as a first-class outcome.

**3. There is no migration documentation of any kind.** No `CHANGELOG.md`, no
migration guide, no upgrade notes. A user going `0.8 → 0.9` today has the
release notes on the GitHub release, if one was cut, and nothing else.

## Non-goals

- **`agentback add <capability>`** — deferred to its own proposal. It reuses
  `create-agentback`'s capability registry but its hard problem is different
  (the `wire` anchors in a pristine `application.ts` are gone or moved in a tree
  the user has edited).
- **`agentback generate <controller|tool|actor>`** — declined, not deferred. It
  is a second source of truth for boilerplate whose only consumer is the coding
  agent, which is already served by `skills/agentback/` and
  `@agentback/introspection`. It contradicts the boundary-coherence thesis in
  [agent-ergonomics.md](../agent-ergonomics.md).
- **`agentback dev`** — npm scripts already do this.
- **`CHANGELOG.md`** — the migration registry is the machine-readable
  equivalent. Generating prose from it later is cheaper than maintaining both.
- **Retroactive codemods** — nothing to migrate (finding 2).

## Design

### Topology

`@agentback/cli` keeps its existing bins (`agentback`, `abc`) and grows two
subcommands:

```
agentback new <name> [--template rest|mcp|hybrid] [--with <caps>] [...]
agentback deploy vercel|cloudflare [...]          # unchanged
agentback update [--to <version>] [--dry-run] [--force]
```

`packages/cli/src/cli.ts:38` currently hard-codes `if (cmd !== 'deploy')`. It
becomes a plain subcommand switch — no router framework, matching the file's
existing restraint. New siblings: `new.ts` and an `update/` directory.

`agentback` with no subcommand prints usage covering all three.

### `new` — a delegate, not a reimplementation

`@agentback/cli` takes a `workspace:~` dependency on `create-agentback` and
calls its already-exported `scaffold()`. No subprocess, no network, no template
duplication. `create-agentback` remains the single source of truth for
scaffolding, and `npm create agentback` continues to work unchanged as the
ecosystem-idiomatic entry point.

No dependency cycle: `create-agentback` depends on nothing else in the
workspace.

### Reuse over invention

Four existing seams carry this design. No parallel machinery is introduced.

| Need                     | Existing seam                                                    |
| ------------------------ | ---------------------------------------------------------------- |
| Arg parsing              | `args.ts`'s `parseDeployArgs` shape → `parseNewArgs`, `parseUpdateArgs` |
| Subprocess (install)     | `exec.ts`'s `nodeExec`, already injected for testability          |
| User-facing failure      | `AgentError` — `cli.ts` already catches it, prints the bare message, exits 1 |
| Package-manager detection| `detectPackageManager` from `create-agentback/scaffold.js`        |

The `exec` injection seam is load-bearing: `runDeploy` already takes
`{exec, fetchFn, cwd}` rather than reaching for globals, so `update`'s install
phase can be asserted in tests without ever spawning a package manager.

### `update` — three phases

The three phases run in order against the app root. `--to` accepts an exact
version only — lockstep releases make a range meaningless here.

**Phase 1 — Resolve.** Read the app's `package.json` and derive `from` by
parsing its `@agentback/*` ranges. Lockstep guarantees they agree; disagreement
is itself a reported finding, not an error. `to` defaults to the running CLI's
own version.

**The CLI must refuse when it is older than the target**, printing the
`npx @agentback/cli@latest update` invocation. This is not an edge case:
`@agentback/cli` is lockstep-versioned, so the binary installed in a `0.9` app
*cannot* contain the `0.9 → 0.10` migration — that entry only exists in the
`0.10` release. The npx path is the normal path, and the error message is where
users learn it. (Same model as `@next/codemod`.)

**Phase 2 — Bump.** Rewrite every `@agentback/*` entry across `dependencies`,
`devDependencies`, and `peerDependencies` to the target caret range, then
install via the detected package manager. Pure string work over parsed JSON —
no AST, no formatting risk.

**Phase 3 — Migrate.** Run every registry entry whose `version` falls in
`(from, to]`.

### The migration registry

One interface. An advisory is a migration with no `apply` — which keeps the
registry a single ordered list and makes "can this be automated?" a property
rather than a taxonomy.

```ts
interface Migration {
  /** Stable slug, e.g. 'mcp-stateless-default'. */
  id: string;
  /** The released version that introduced the break. */
  version: string;
  title: string;
  /** Static analysis only — never boots the app. */
  detect(ctx: MigrationContext): Finding[];
  /** Present ⇒ codemod. Absent ⇒ advisory. */
  apply?(ctx: MigrationContext): void;
}

interface Finding {
  file?: string;
  line?: number;
  message: string;
  /** What the user should do, when `apply` cannot do it for them. */
  action: string;
}

interface MigrationContext {
  /** App root. All paths in `Finding` are relative to it. */
  root: string;
  /** Parsed package.json, post-bump. */
  pkg: PackageJson;
  /** Lazily constructed over the app's tsconfig; only built when first read. */
  project(): Project; // ts-morph
  from: string;
  to: string;
}
```

`project()` is lazy so an advisory that only reads `package.json` or a config
file never pays to parse the source tree.

**Detection never boots the app.** Findings come from static source reads and
config files only, so `update` works on a tree that has not been installed or
built. This is a hard constraint, not a preference: the bump phase changes what
`node_modules` should contain, so anything requiring a working install would
have to run before or after the very change it is reasoning about.

**Engine: ts-morph, as a real dependency of `@agentback/cli`.** It vendors its
own TypeScript via `@ts-morph/common`, so it is immune to whatever `typescript`
version the user's app pins — which matters given the framework's own TS 6/TS 7
side-by-side arrangement and the template's `typescript: ^5.9.0`. The type
checker stays reachable for a future migration that needs it. A real dependency
rather than the repo's usual optional-peer-plus-lazy-import convention, because
an optional peer is not installed by `npx`, and npx is the primary invocation.
Install weight is acceptable: `@agentback/cli` is tooling and never appears in a
deployed bundle.

### Safety

- Refuse to write to a dirty git tree unless `--force`. Git is the undo
  mechanism; no backup files are written.
- `--dry-run` reports findings and the intended `package.json` diff without
  touching disk or installing.
- Codemods that would touch a file are reported even under `--dry-run`.

### Seed registry (v1)

Three advisories, all at `0.9.0`. Zero codemods ship — the `apply` path is
exercised by tests only (see Testing), until a real transform exists.

| `id`                          | Source     | Detects                                                                 |
| ----------------------------- | ---------- | ----------------------------------------------------------------------- |
| `mcp-stateless-default`       | `9308a3cd` | `installMcpHttp`/`MCPServer` config relying on session behaviour — `eventStore` set without a `protocol`, or code reading `Mcp-Session-Id`. Action: pin `protocol: 'legacy'` or migrate. |
| `mcp-stateless-scope-holes`   | `f746061b` | `@tool({scope})` combined with `strategyAuth: {required: false}`, and multi-instance deploys with no explicit `MCPBindings.CONFIRMATION_STORE` binding. |
| `mcp-origin-validation`       | `1b6290be` | `installMcpHttp` without `allowedOrigins` where `rest.cors` is a callback or true wildcard — the case that warns and leaves validation off. |

Each entry's `action` text is the user-facing migration note, which is what
makes the registry a substitute for the missing changelog rather than an
addition to it.

## Testing

Tests follow the convention already in `packages/cli`: temp app trees built in
code with `mkdtempSync` + `writeFileSync` (`detect.unit.ts:14`,
`run-deploy.unit.ts:35`), **not** on-disk fixture directories. This is not only
consistency — vitest globs `packages/*/dist/__tests__/**`, so a fixture tree of
`.ts` files under `src/` would be swept into `tsc -b`.

| Layer       | Coverage                                                                 |
| ----------- | ------------------------------------------------------------------------ |
| unit        | `parseUpdateArgs`, `parseNewArgs`                                        |
| unit        | Version resolution, including the disagreeing-ranges finding and the CLI-older-than-target refusal |
| unit        | Range rewriting across `dependencies`, `devDependencies`, `peerDependencies` |
| unit        | Each advisory's `detect()` against a tree that **has** the pattern and one that **does not** |
| unit        | Bump phase with a stub `exec`, asserting the install command without spawning a package manager |
| integration | The `apply` seam against a synthetic ts-morph transform, asserting **untouched regions are byte-identical** |

Two of these carry most of the weight:

**False-negative and false-positive coverage per advisory.** A registry that
cries wolf is worse than no registry, because users learn to skip the output.
Every advisory needs the negative case.

**The formatting-fidelity assertion.** This must exist in v1 even though no real
codemod ships. Scaffolded apps carry **no prettier** — there is nothing to
normalize a reflowed file afterward, so ts-morph reprint damage is permanent and
user-visible. Shipping the seam unproven means the first real transform in
`0.10` is also the first test of whether it mangles source.

An `update` e2e using the existing `packages/cli/fixtures/cf-app` buildable
fixture is deliberately **out of v1** — the unit and integration layers cover
the logic, and a second fixture app is real maintenance weight for an untested
payoff.

## Build wiring

Add `{"path": "../create-agentback"}` to `packages/cli/tsconfig.json`'s
`references`. Root `tsconfig.json` already orders `packages/create-agentback`
(line 53) ahead of `packages/cli` (line 54), so no reordering is required.

## Documentation surfaces (acceptance criteria)

Listed here as spec acceptance criteria rather than delegated to CLAUDE.md's
checklist, because that checklist already missed this exact surface once: the
`create-agentback` capability work from the 2026-06-16 design shipped and the
skill was never updated.

- [ ] `packages/cli/README.md` — all three subcommands
- [ ] **New** `skills/agentback/references/cli.md` — `deploy` has no reference
      page today, only prose at `composition-and-operations.md:493`
- [ ] `skills/agentback/SKILL.md:69–104` — **fix the stale scaffolder section**:
      `--with`/`--drizzle`/`--auth`/`-c`, `--port`/`--host`/`--base-path`,
      interactive mode, and the corrected `ScaffoldOptions` signature (it
      currently documents `{name, template?, cwd?, version?}` only)
- [ ] `skills/agentback/SKILL.md` routing table — an entry for "upgrade an app
      across a breaking release"
- [ ] `docs/packages.md` — `@agentback/cli` row reflects the lifecycle scope
- [ ] `docs/proposals/README.md` — E-5 row
- [ ] `CLAUDE.md` — capability list entry; run `pnpm agents-md`

## Decisions log

Locked during brainstorming (2026-08-04). Recorded so a later reader can see
what was rejected and why.

| Decision                                            | Rejected alternatives                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| Spec covers topology + `update`; `add` deferred      | All three in one spec (neither subsystem gets specified precisely enough)  |
| Registry holds codemods **and** advisories           | Codemods only (covers none of the released breaks); advisories only        |
| Forward-only; no retroactive codemods                | Backfill both, or backfill `@arg` only — no released version shipped them  |
| ts-morph                                             | jscodeshift/recast (better formatting fidelity, no type info); TS compiler API directly |
| ts-morph a real dep of `@agentback/cli`              | Split `@agentback/codemod`; optional peer (breaks the npx path)            |
| `new` delegates via `scaffold()`                     | Pointer that prints the canonical command; subprocess `npx`; no `new`      |

## Open questions

- **Should `update` also run `pnpm build` and report type errors after
  migrating?** It would surface exactly the breakage the advisories predict, but
  it couples `update` to a working toolchain and turns a fast command into a
  slow one. Leaning no; revisit once a real codemod exists.
