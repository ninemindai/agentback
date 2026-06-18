# `agentback deploy cloudflare` (Phase 2a) — Design

**Date:** 2026-06-17
**Status:** Partially delivered — tooling + accurate doctor landed; full `RestApplication`-on-Workers deferred (see status note).
**Supersedes/extends:** [2026-06-17-agentback-deploy-design.md](2026-06-17-agentback-deploy-design.md) (Phase 1, Vercel). This is the first slice of that spec's §12 "Phase 2" carve-out.

> **⚠️ Implementation status (2026-06-17).** Landed: the deploy tooling (`DeployTarget` extraction, Cloudflare target, fetch-leaf worker + `wrangler.toml`, `AssetSource` D+C, CLI wiring) and an **accurate, tree-shaking-aware bundle doctor** (`nodejs_compat`-correct DENY list + bare-name detection), plus an edge-safety down-payment (`@agentback/common` dotenv/env no longer pollutes a Worker bundle).
> **Deferred:** the doctor honestly reports that a real `RestApplication` does **not** yet bundle clean for a Workers isolate — it pulls Express's transitive ecosystem (multer/busboy, etag, cookie-signature, send→`fs`). The "fetch handler ⇒ runs on the edge" assumption held for the *logic* but not the *packaging*. Tracked in **[2026-06-17-restapplication-edge-readiness-followup.md](2026-06-17-restapplication-edge-readiness-followup.md)** (a lazy-Express starting point exists at commit `4a906d0`). The credential-gated CF e2e validates the doctor + pipeline against an edge-clean `createFetchHost` worker; the real-app e2e waits on the follow-up. The doctor correctly saying "not edge-ready yet" — instead of greenlighting a worker that would 500 — is itself a primary outcome of this phase.
**Scope:** Add **Cloudflare Workers** as a deploy target for an AgentBack app's **REST + OpenAPI** surface, by extracting a reusable `DeployTarget` seam from the concrete Vercel path and adding a Cloudflare adapter, a static bundle doctor, and a CDN-backed `AssetSource` so the dev UIs work without a filesystem. **Edge MCP, Deno Deploy, and Vercel `--edge` are Phase 2b (separate spec).**

---

## 1. Goal & framing

Phase 1 shipped `agentback deploy vercel` on Vercel's **Node** runtime (Express leaf, real filesystem). Phase 2a takes AgentBack to a **true edge isolate** — Cloudflare Workers — where there is **no filesystem** and **no Node listener**, only a Web `fetch` handler. The single most important outcome is **proof**: a real `wrangler deploy` of an AgentBack app that serves `/openapi.json`. Until that passes, "Cloudflare support" is a claim, not a fact.

The runtime precondition already exists: `packages/rest/src/host/fetch.ts` exposes `RestServer.fetchHandler()` — a runtime-neutral `fetch(Request): Promise<Response>` — and `examples/hello-hosts` runs one app unchanged on Bun/Hono/native. Phase 2a is the tooling + the two genuinely-edge-specific fixes (bundling safety, disk-served assets) that get that handler onto Workers.

**Non-goals (2a):** MCP-over-HTTP on edge, Deno Deploy, Vercel Edge runtime, embedding custom static dirs, `--env` forwarding. See §8.

## 2. Locked decisions (this spec)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Target | **Cloudflare Workers (REST + `/openapi.json`)** | Purest `fetch`-handler target; one `wrangler deploy`. Reference edge target. |
| 2 | Abstraction | **Extract `DeployTarget` now** (from Vercel + CF, two real impls) | Phase 1 deliberately deferred this; the seam can now be derived from evidence, not guessed. |
| 3 | Entry leaf | **`fetchHandler()` → `export default { fetch }`** | Workers have no Express/Node listener; the fetch path also tree-shakes the Node listener out. |
| 4 | File location | **Ephemeral `.agentback/deploy/cloudflare/worker.ts`**, `--eject` to repo root | Wrangler's `main` can point anywhere (unlike Vercel's forced `api/`), so the clean-repo model returns. |
| 5 | Bundling | **Wrangler bundles** (its built-in esbuild); we don't | Consistent with Phase 1's "orchestrate the platform CLI." |
| 6 | Bundle doctor | **Static preflight** (esbuild analyze pass) before `wrangler deploy` | Catch denied `node:` imports early with a named culprit, not as a runtime 500 in the isolate. |
| 7 | Static assets | **`AssetSource` D (formalize) + C (CDN dev UIs)**; defer B (embed) | `serveStaticDir`'s disk read is the only true edge wall; CDN-load published npm assets by version. |
| 8 | Console on edge | **Supported via the CDN AssetSource**, still gated | The Phase 1 resolved-builder console gate carries over unchanged. |

## 3. `DeployTarget` extraction (refactor first)

Phase 1's `run-vercel.ts` is a concrete pipeline. With a second real target, extract the shared shape. **This is a refactor that must not change Vercel behavior** — the Phase 1 test suite is the regression guard.

Split into:
- `packages/cli/src/run-deploy.ts` — the generic pipeline, target-agnostic:
  `resolveBuilder → console-gate (on resolved builder) → generate (entry + config) → preflight → deploy → verify`.
- `packages/cli/src/targets/vercel.ts` — the existing Vercel behavior, moved behind the interface, byte-identical output.
- `packages/cli/src/targets/cloudflare.ts` — the new adapter.

```ts
export interface DeployTarget {
  id: 'vercel' | 'cloudflare';
  /** The deployable entry: path (where to write) + contents (generated source). */
  generateEntry(builder: ResolvedBuilder, opts: GenerateOpts): {path: string; contents: string};
  /** Platform config file edits (idempotent, order/merge-aware). */
  generateConfig(opts: GenerateOpts): FileEdit[];
  /** CLI installed + authed (+ bundle doctor for cloudflare). Returns diagnostics. */
  preflight(deps: RunDeps): Promise<Diagnostic[]>;
  /** Shell the platform CLI; return the live URL. */
  deploy(opts: DeployOpts, deps: RunDeps): Promise<{url: string}>;
  /** Default REST liveness path (overridable by --verify-path). */
  defaultVerifyPath(): string;
}
```

`GenerateOpts` carries `{builder, cwd, isConsoleBuilder, force, eject}` so both targets see the same console-resolution result. The `--console`/resolved-builder gate logic from Phase 1 moves into `run-deploy.ts` (shared), not per-target.

**Target selection:** `agentback deploy <target>` already validated `vercel` in Phase 1; `cloudflare` (alias `cf`/`workers`) is added to the accepted set, dispatching to the cloudflare `DeployTarget`.

## 4. The Cloudflare Worker entry (fetch leaf)

The one structural difference from Vercel: the leaf is the **fetch handler**, not the Express app.

```ts
// .agentback/deploy/cloudflare/worker.ts (generated; safe to --eject and edit)
import {<export>} from '<entry>';   // resolved builder, e.g. buildApp

let booted: Promise<{fetch(req: Request): Promise<Response>}> | undefined;
const host = () =>
  (booted ??= (async () => {
    const app = await <export>({listen: false});
    const server = await app.restServer;
    return server.fetchHandler();          // runtime-neutral {fetch}
  })());

export default {
  async fetch(req: Request, env: unknown, ctx: unknown): Promise<Response> {
    return (await host()).fetch(req);
  },
};
```

- Memoized so the app builds **once per isolate cold start**; warm requests reuse the promise.
- Imports the **fetch path** (`fetchHandler()`), never `app.start()` — so wrangler's esbuild drops `createNodeListener` (§6).
- `<entry>` is repo-root-relative; from `.agentback/deploy/cloudflare/` it gets the correct relative prefix (same path-rewrite logic as Phase 1's `entryFromApi`, generalized).

## 5. `wrangler.toml`

Idempotent, conflict-aware merge (same philosophy as Phase 1's `vercel.json`): preserve user keys, warn on a real conflict, fail unless `--force`/`--eject`.

```toml
name = "<name>"
main = ".agentback/deploy/cloudflare/worker.ts"
compatibility_date = "<recent fixed date>"
compatibility_flags = ["nodejs_compat"]
```

- `nodejs_compat` + a recent `compatibility_date` are what make `node:crypto`/`node:stream`/`node:url` resolve in the isolate.
- **TOML, not JSON** — needs a parse/merge. Use a small dependency (`smol-toml`) or a conservative known-key patch (read text, ensure the 4 keys, append if absent). The merge must round-trip user keys; prefer the library to avoid hand-rolling a TOML writer.

## 6. Bundle doctor (static preflight)

Runs in `cloudflare.preflight()`, **before** `wrangler deploy`. It is an **esbuild analyze pass** (bundle the worker entry to an in-memory result with `metafile: true`, `write: false`) — *not* the deploy bundle, which wrangler still owns. From the metafile's resolved inputs, check every `node:`/external module against:

| Module | Verdict |
|---|---|
| `node:crypto`, `node:stream`, `node:url`, `node:buffer`, `node:events`, `node:async_hooks`, `node:util` | **Allow** (nodejs_compat-backed) |
| `node:fs`, `node:fs/promises`, `node:path` (disk), `node:net`, `node:http`/`node:https` (listener), `node:child_process` | **Hard-fail** — name the module **and** the likely culprit (e.g. `serveStaticDir`; tell the user to use the CDN `AssetSource` from §7) |

Outcomes:
- **Clean graph →** proceed to `wrangler deploy`. (The analyze pass also confirms the entry *compiles*, catching a broken builder before a remote deploy.)
- **Denied module →** fail fast with `AgentError`, the module path, the importing file, and the remediation.

esbuild is already a workspace dependency (UI client builds use it), so no new heavy dependency. The allow/deny list is a small, reviewed constant — the maintained core of the doctor.

## 7. `AssetSource` — D + C (the disk-asset fix)

`serveStaticDir(dir)` already returns `(suffix: string) => Promise<Response | undefined>` — the disk dependency is an implementation detail of one factory, not the contract. **Disk stays the default on Node; nothing breaks.**

```ts
type AssetSource = (suffix: string) => Promise<Response | undefined>;

fromDisk(dir): AssetSource     // (D) current serveStaticDir behavior; default on Node
fromCdn(baseUrl): AssetSource  // (C) fetch/redirect to a CDN-hosted asset
// fromEmbeddedMap(map)        // (B) deferred — custom-dir embed
// fromPlatformAssets(binding) // deferred — Workers native assets binding
```

- **(D) Formalize** in `@agentback/rest`: rename the internal to `fromDisk`, export `AssetSource`; `installConsole`/`installExplorer`/`installInspector` (`@agentback/console`, `rest-explorer`, `mcp-inspector`) gain an optional `assets?: AssetSource`, default `fromDisk`.
- **(C) CDN dev UIs:** add `fromCdn`. jsdelivr/unpkg serve **any published npm package's files by version**, so both `swagger-ui-dist` *and* `@agentback/console@<version>/dist/client/*` (and the inspector bundle) are CDN-addressable with no self-hosting and no bundled bytes. On a Cloudflare deploy, the generated worker (or the install\* call) wires `fromCdn` for the dev UIs so the console/explorer load their assets from the CDN.

**Console-on-edge gate:** unchanged from Phase 1 — the gate keys off the resolved builder (`buildConsoleApp`) and requires auth or `--unsafe-public-console`. CDN-loading assets does not change what's exposed, so the gate still governs publishing internals.

**Deferred: B** (`--bundle-assets` embed) — only matters for users with *custom* `serveStaticDir` directories; the framework's own dev UIs are fully covered by C. YAGNI for the foundation.

## 8. CLI surface (added this phase)

```
agentback deploy cloudflare [options]      # aliases: cf, workers

  --entry / --export        same build-entry contract as vercel
  --name <n>                worker name (default: package.json "name") — wired into wrangler.toml
  --console                 deploy the dev console (CDN assets); gated (auth or --unsafe-public-console)
  --unsafe-public-console   acknowledge publishing console internals
  --eject                   write worker.ts + wrangler.toml to repo root, then stop
  --force / --dry-run / --yes / --verify-path   as in Phase 1
```

(Note: `--name` IS used here — `wrangler.toml`'s `name` is a real, non-deprecated field, unlike Vercel's dropped `--name`.)

## 9. Testing strategy

- **Unit / snapshot (default CI, no creds):**
  - `targets/cloudflare.generateEntry` — snapshot the worker.ts (fetch leaf; correct relative `<entry>`).
  - `targets/cloudflare.generateConfig` — fresh `wrangler.toml`; existing-file merge preserves user keys; conflict → fail unless `--force`/`--eject`.
  - **bundle doctor** — feed a fixture import graph: denied module (`node:fs`) → fails with culprit; clean graph → passes. (Drive esbuild over small fixture entries.)
  - `AssetSource` — `fromDisk` unchanged (existing serveStaticDir tests); `fromCdn` returns the right CDN `Response`/redirect for a suffix.
  - `run-deploy` pipeline with the cloudflare target (mocked `exec`): eject, dry-run, deploy+verify, not-authed, bundle-doctor-fail.
- **Regression (CRITICAL):** the **entire Phase 1 Vercel suite must stay green** after the `DeployTarget` extraction — Vercel output byte-identical.
- **One opt-in, credential-gated e2e (`CLOUDFLARE_API_TOKEN` + `ABC_E2E_CLOUDFLARE=1`):** a real `wrangler deploy` of a fixture AgentBack Worker app → assert `/openapi.json` returns 200. **This is the acceptance gate that proves the isolate works.** Not in default CI; runnable on demand + pre-release.
- A small fixture app (REST-only `@api` controller) for the e2e, under `examples/` or a test fixtures dir.

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| DI/decorator bundle doesn't run in a Workers isolate | **High (the core unknown)** | The credential-gated e2e is the acceptance gate — no "CF support" claim until a real deploy serves `/openapi.json`. The eng-review analysis (reflect-metadata portable; node:crypto/stream/url under nodejs_compat) says it should; this proves it. |
| A transitive `node:fs`/`node:path` leak (beyond serveStaticDir) | Medium | Bundle doctor's allow/deny list fails early with the importing file named. |
| `wrangler.toml` TOML merge corrupts user config | Medium | Use a real TOML lib (round-trips keys); idempotent + conflict-warn like `vercel.json`. |
| CDN dependency for dev UIs (offline/CSP/air-gapped) | Low | REST + `/openapi.json` need no CDN; documented. Embed (B) / native assets are the later escape hatches. |
| `DeployTarget` extraction regresses Vercel | Medium | Phase 1 suite is the guard; extraction lands with all Vercel tests green before the CF adapter is added. |

## 11. Build sequence (for the implementation plan)

1. **Extract `DeployTarget`**: `run-deploy.ts` generic pipeline + `targets/vercel.ts` (move Phase 1 behavior behind the interface). All Phase 1 tests green — no behavior change.
2. **`AssetSource` (D)** in `@agentback/rest`: formalize the seam, `fromDisk` default, `install*` `assets?` option. Existing tests green.
3. **`AssetSource` (C)** `fromCdn` + wire the dev UIs to CDN on cloudflare deploys.
4. **`targets/cloudflare.ts`**: worker entry gen (fetch leaf) + `wrangler.toml` merge + `--name` wiring.
5. **Bundle doctor** (esbuild analyze + allow/deny list) in `cloudflare.preflight()`.
6. **Wire `cloudflare` into the CLI** (`deploy cloudflare` + aliases) + dry-run/eject.
7. **Unit/snapshot suite** + the credential-gated CF e2e + fixture app. Docs (`docs/guides/deploy-to-edge.md`).

## 12. Out of scope (Phase 2b / later)

| Deferred | Why |
|---|---|
| **Edge MCP-over-HTTP (stateless mode)** | Needs `sessionIdGenerator: undefined` in `@agentback/mcp-http` + a product decision (stateless loses server→client streaming/progress). Its own focused spec. |
| **Deno Deploy** | Second edge adapter; mostly parallel to CF, lands after the seam is proven. |
| **Vercel `--edge`** | Vercel Edge runtime leaf; bundles with the edge-MCP/stateless work. |
| **`AssetSource` B (embed) + native Workers assets binding** | Custom-dir embedding / platform-native asset hosting; not needed for the framework's own dev UIs. |
| **`--env`/secret forwarding** | Build-vs-runtime semantics; add when a real deploy needs it. |
