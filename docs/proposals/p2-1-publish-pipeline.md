# Proposal P2-1: Publish Pipeline (prerequisite for the `npm create` UX)

**Status:** Phase 1 implemented (2026-06-10) — manual `workflow_dispatch`
release workflow; checklist below tracks the remaining pre-publish items.
**Related:** [p0-4-dx-floor.md](p0-4-dx-floor.md) (gated on this).

## Motivation

Packages are versioned locally but unpublished; the root is `private: true`. Until
`@agentback/*` exists on npm, `npm create agentback` is dead on
arrival, `@agentback/testing` can't be installed by external apps, and
the scaffold templates' `{{version}}` substitution has nothing real to point
at. This was the eng review's #1 critical finding against P0-4.

## Design (phase 1 — deliberate minimalism)

Pre-alpha wants a **boring, manual, all-at-once** release: every
`@agentback/*` package shares one version, published together from a
maintainer-dispatched workflow. No changesets, no per-package versioning, no
release automation deps — those earn their complexity post-1.0.

`.github/workflows/release.yml` (`workflow_dispatch` with a `version` input):

1. Checkout, pnpm install (frozen lockfile), build, full test (with the Redis
   service container, matching CI).
2. Set the version across all publishable workspace packages
   (`pnpm -r exec npm version <version> --no-git-tag-version`, examples are
   `private: true` and skip themselves).
3. `pnpm -r publish --access public --no-git-checks --provenance` — npm
   provenance ties every artifact to the workflow run.
4. Tag `v<version>` and push the tag (the workflow's only write-back).

Auth: an `NPM_TOKEN` repo secret (granular, publish-only, `@AgentBack`
scope) wired as `NODE_AUTH_TOKEN`. **Nothing publishes until a maintainer
creates the secret and dispatches the workflow** — merging this proposal has
no outward effect.

## Pre-publish checklist (tracked, not yet done)

- [ ] Claim the `@AgentBack` npm scope (or decide the final scope name —
      coordinate with the OSS/proprietary split).
- [ ] `repository`/`homepage`/`license` fields in every package.json
      (one scripted pass; MIT field already implied by LICENSE).
- [ ] Decide `create-agentback`'s unscoped name availability.
- [ ] First dispatch with `0.1.0-alpha.1`; verify provenance + install from a
      clean machine; then flip P0-4's templates from `{{version}}`-at-scaffold
      to the published dist-tag default.
- [ ] README badges + install docs once live.

## Out of scope (phase 2+)

- Changesets / per-package independent versions.
- Automated release-on-merge; canary/nightly dist-tags.
- GitHub Releases changelog generation.
