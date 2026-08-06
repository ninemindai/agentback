# Lifecycle CLI (`@agentback/cli`)

The **ops** CLI: it operates _on_ an AgentBack app — scaffold it, deploy it,
upgrade it. Bins: `agentback` and the short alias `abc`.

> **Not [`@agentback/command`](command.md)** — that is a library that turns an
> app's own `@tool` classes into a command surface. That one makes _your app_ a
> CLI; this one is a CLI that acts on your app. They never overlap.

```
agentback new <name> [--template hybrid|rest|mcp] [--with <caps>]
agentback deploy (vercel|cloudflare) [options]
agentback update [--to <version>] [--dry-run] [--force]
agentback --version
```

Exit codes: `0` success, `1` failure. **Migration notes are advisory and do not
change the exit code**; `update`'s post-install audit does (see below).

## `agentback new`

Delegates to `create-agentback`'s `scaffold()` in-process; templates are never
duplicated. Same flags as `npm create agentback` (see the Getting Started
section of SKILL.md for the capability table), including the `--flag=value`
form.

**Deliberately non-interactive.** `npm create agentback` with no name on a TTY
opens a wizard; `agentback new` with no name errors and points there. If you
want prompts, use `npm create agentback`.

## `agentback deploy`

Runs generate → preflight (bundle doctor) → the platform CLI → verify
`/openapi.json`.

| Flag                                 | Effect                                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--prod`                             | production deploy (default: preview)                                                                                                                                                              |
| `--entry <path>` / `--export <name>` | the built module + export producing the app (default `buildApp`; auto-detected from `dist/`)                                                                                                      |
| `--eject`                            | write `api/index.ts` + `vercel.json` and stop, so you can deploy by hand                                                                                                                          |
| `--dry-run`                          | generate + preflight only, never deploy                                                                                                                                                           |
| `--temporary`                        | cloudflare only: a throwaway preview account, no signup, 60-min TTL. Works **only unauthenticated** (wrangler refuses it when logged in or `CLOUDFLARE_API_TOKEN` is set); needs wrangler ≥ 4.102 |
| `--console`                          | also deploy the dev console — needs auth, or `--unsafe-public-console` to acknowledge publishing internals                                                                                        |
| `--verify-path <p>`                  | OpenAPI path to verify (default `/openapi.json`)                                                                                                                                                  |
| `--force`                            | overwrite a conflicting `vercel.json` / `api/index.ts`                                                                                                                                            |

Deployment gotchas (static assets missed by file tracers, workspace symlinks)
are in [composition-and-operations.md](composition-and-operations.md).

## `agentback update`

Upgrades an app across an AgentBack release. Four phases:

1. **Resolve** — derive the app's current version from its `@agentback/*`
   ranges. Lockstep means they agree; disagreement is reported and the _lowest_
   wins so no migration is skipped.
2. **Migrate** — run every migration in the half-open window `(from, to]`.
3. **Bump + install** — rewrite the ranges to `^<to>` and install with the
   app's package manager.
4. **Audit** — re-read the tree and **exit 1** if any `@agentback/*` still
   resolves below the target.

**Run it via `npx`:**

```bash
npx @agentback/cli@latest update --dry-run   # report only, write nothing
npx @agentback/cli@latest update
```

`@agentback/cli` is lockstep-versioned, so the copy installed in a `0.9` app
**cannot contain the `0.9 → 0.10` migrations** — those ship with `0.10`. The CLI
refuses when it is older than its target and prints this invocation. (Same model
as `@next/codemod`.)

| Flag             | Effect                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `--to <version>` | exact target version (default: the running CLI's own version). Exact only — lockstep makes a range meaningless |
| `--dry-run`      | report findings and the intended bump; write nothing, install nothing                                          |
| `--force`        | proceed on a dirty git tree, **and** permit a downgrade                                                        |

**Migrations are codemods or advisories.** Most breaking changes cannot be
transformed — a default flipping, a header no longer existing — so an advisory
reports what changed and what to do, with `file:line` where it can. As of
`0.9.0` there are three advisories and zero codemods: no published version ever
shipped a source-mechanical breaking change.

### Things worth knowing

- **Git is the undo mechanism.** `update` refuses to write to a dirty tree
  unless `--force`, and warns (rather than silently proceeding) if it cannot run
  `git status` at all.
- **Migrations run before the bump.** A failed install therefore cannot poison
  the migration window — `package.json` still names the old version, so a re-run
  repeats the same detection.
- **It never boots your app.** Detection is static source and config reads, so
  `update` works on a tree that has never been installed or built.
- **Formatting is preserved.** The manifest keeps its own indentation, and the
  codemod path is guarded by a test asserting untouched regions stay
  byte-identical.
- **Ranges it cannot read, it does not touch.** A `latest`, an `npm:` alias, or
  a compound range is reported for manual handling rather than rewritten.
- **Run it from the workspace root.** Every phase walks the whole topology —
  pnpm `packages:` globs and npm/yarn `workspaces` — so sub-package pins are
  bumped, their `src/**` is scanned by the advisories, and the report names the
  file each entry came from (`packages/app/package.json:@agentback/rest`). The
  root manifest keeps its bare form. `workspace:` ranges are still skipped by
  design.
- **Overrides are rewritten too.** `pnpm-workspace.yaml` `overrides` (and
  `catalog`), plus package.json `overrides`/`resolutions`/`pnpm.overrides`. An
  override outranks every range in the file, so one left behind silently re-pins
  the old version after a bump that looked like it worked — this was the real
  blocker in the field. The YAML edit is line-targeted: quote style, alignment
  and comments survive byte-for-byte, and a pin it cannot read (flow style, a
  dist-tag) is **reported**, never guessed at.

### The audit is the only thing that changes the exit code

Migration notes are advisory. A version still resolving below the target is not:
after the install, `update` re-derives what is actually on disk and exits **1**,
listing every offending site.

It is deliberately built from **different parts than the bump phase** — a net
woven from the same enumeration cannot catch that enumeration's own bugs, which
is exactly how three workspace gaps each shipped looking like a successful
update. Manifests come from a filesystem walk (not workspace globs), pins from a
deep scan of the whole manifest (not a section list), YAML pins from a raw-text
match (including the flow style the rewriter refuses), and installed versions
from reading `node_modules/@agentback/*/package.json` — so the question answered
is "what did the package manager actually install", not "what do we believe we
asked for". Only a version strictly **below** the target counts; a caret
resolving `0.10.1` for a `0.10.0` target is the normal outcome.
