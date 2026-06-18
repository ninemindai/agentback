# Contributing to AgentBack

Thanks for looking under the hood. The project is in alpha and moving fast;
this document keeps contributions cheap to review and safe to land.

## Setup

Requirements: **Node 22.13+** and **pnpm 11**.

```bash
pnpm install          # workspace deps (pnpm 11 may ask you to approve postinstall builds)
pnpm build            # tsc -b across the workspace (project references)
pnpm test             # vitest — REQUIRES a prior `pnpm build`
pnpm lint             # eslint + prettier --check
pnpm lint:fix         # auto-fix
```

The one rule that surprises everyone: **tests run against built `dist/`, not
`src/`**. `vitest.config.ts` globs
`packages/*/dist/__tests__/**/*.{test,spec,unit,integration,acceptance}.js`.
After editing any `.ts` file, run `pnpm build` (or keep `pnpm build:watch`
running) before `pnpm test` will see the change. The same applies to running
`examples/*`.

Running one test file or pattern:

```bash
pnpm exec vitest run packages/rest/dist/__tests__/integration/rest-server.integration.js
pnpm exec vitest run -t "name of test"
```

## Repository shape

- `packages/*` — the framework, one npm package per directory. The root
  `tsconfig.json` lists project references in dependency order; a new package
  must be added there and have its own `tsconfig.json` declaring its
  references.
- `examples/*` — runnable end-to-end stories. Every substantial feature
  should be visible in at least one example.
- `docs/` — concepts, guides, architecture, proposals, and the blog.

Two kinds of code live here, with different rules:

1. **Ported from upstream LoopBack 4** (`metadata`, `context`, `core`,
   `http-server`, `express`, the auth stack, `testlab`): stay faithful to
   upstream semantics. Don't refactor for taste.
2. **Rewritten for this project** (`openapi`, `rest`, `mcp`, `client`, and
   everything agent-era): the design rule is **boundary coherence** — one
   Zod schema per boundary, everything else derived. Read
   [docs/agent-ergonomics.md](docs/agent-ergonomics.md) before adding a
   feature that might introduce a second source of truth alongside the
   schemas.

## Making changes

- **Design first for anything non-trivial.** Substantial features start as a
  proposal in [docs/proposals/](docs/proposals/README.md) — see the existing
  P-series docs for the shape (motivation, design, implementation plan, out
  of scope).
- **Tests are required.** Unit tests live in
  `packages/<pkg>/src/__tests__/unit/`, integration tests in
  `.../integration/`, named `*.unit.ts` / `*.integration.ts`. The
  `@agentback/testing` package (`createTestApp`) is the harness for
  app-level tests; see [docs/guides/testing.md](docs/guides/testing.md).
- **Commit messages** follow conventional-commit style as used in the
  history: `feat(rest): …`, `fix(deps): …`, `docs(proposals): …`.
- **Style** is enforced by the tools, not by reviewers: Prettier (single
  quotes, no bracket spacing, 80 columns, trailing commas) and the ESLint
  flat config (warns on `any` and unused vars — prefix intentional unused
  with `_`).

## Licensing and file headers

The project is MIT (root `LICENSE`). Every source file in `packages/*` and
`examples/*` carries the three-line header:

```ts
// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/
```

Keep it on new files. Do **not** add `Copyright IBM Corp.` headers to ported
code — upstream attribution lives once in `THIRD-PARTY-NOTICES.md`, as MIT
permits. If you port code from another MIT/BSD/Apache project, add its
notice there.

Files emitted by the `create-agentback` scaffold into **user projects**
deliberately carry no copyright header: generated code belongs to the user,
under whatever terms they choose.

## Dependencies

Default policy is "latest everything" via `ncu -ws --root -u`, with three
standing exceptions documented in [CLAUDE.md](CLAUDE.md): `@types/node`
pinned to even (LTS) majors, `express` on `^4`, `p-event` on `^6`. If a bump
breaks the build, prefer pinning the offender back (with a one-line reason
in the commit) over patching code. Commit `pnpm-lock.yaml` together with any
`package.json` change — CI installs with `--frozen-lockfile`.

## CI

`.github/workflows/ci.yml` runs `pnpm install --frozen-lockfile && pnpm
build && pnpm test` on Node 22.13 and 24. Green CI, lint-clean, and an
updated example or guide (when behavior is user-visible) are the bar for
merging.
