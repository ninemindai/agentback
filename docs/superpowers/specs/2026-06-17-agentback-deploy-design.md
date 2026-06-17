# `agentback deploy vercel` — Design (Phase 1)

**Date:** 2026-06-17
**Status:** Approved design (eng-reviewed), pre-implementation
**Scope:** A first-party CLI that deploys an AgentBack app's **REST + OpenAPI** surface to **Vercel**, by codifying the setup `agentback-demo` already runs in production. Edge runtimes (Cloudflare/Deno), live MCP-over-HTTP, and the `DeployTarget` abstraction are **Phase 2** — a separate spec (§12).

---

## 1. Goal & framing

Give AgentBack users a one-command path from a local app to a running Vercel deployment:

```bash
agentback deploy vercel
abc deploy vercel --prod
```

The precondition is already proven: `agentback-demo` (`weather-mcp`) deploys to Vercel
today via a hand-written `api/index.ts` (memoized async boot handing Vercel the Express
app) plus a `vercel.json`. Phase 1 **turns that proven, hand-built setup into a
generator** — nothing more exotic. It touches **no existing package**; it is a new,
additive `@agentback/cli`.

**Non-goals (Phase 1):** edge runtimes, live MCP-over-HTTP, multi-target abstraction,
secret/env forwarding. See §12.

## 2. Locked decisions (this spec)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | CLI scope | New **`@agentback/cli`**, bins `agentback` + `abc`, **`deploy vercel` only** | One verb, smallest surface; `ab` not claimed (shadows ApacheBench). |
| 2 | Deployed surface | **REST + `/openapi.json` by default**; console opt-in + gated | Console exposes DI internals/schema/inspector; `installConsole` refuses unauthenticated without an explicit unsafe flag. Don't publish internals by default. |
| 3 | File location | **Repo root** (`api/index.ts`, `vercel.json`); no hidden ephemeral dir | Vercel discovers functions/config relative to the deploy root. A `.agentback/deploy/` subdir is never seen. |
| 4 | App-build contract | **Explicit `--entry`/`--export`**, default to a detected exported builder | The demo imports `buildConsoleApp` from a built module, not `src/application.ts`; deploy must not guess how to boot the app. |
| 5 | Generated handler types | **Node `IncomingMessage`/`ServerResponse`** (`RequestListener`), not `@vercel/node` | Avoid forcing an undeclared `@vercel/node` dep on the user's app (the demo already types it this way). |
| 6 | File generation | **Inline template literals** in the Vercel code path | Two ~30-line files don't justify template-file machinery; explicit + smallest diff. |
| 7 | `vercel.json` writing | **Idempotent, order-aware merge**; fail on conflict unless `--force`/`--eject` | `rewrites` is an ordered array; a naive deep-merge can steal or miss routes, or clobber user keys. |
| 8 | Target abstraction | **None in Phase 1** — concrete Vercel path | Designing `DeployTarget` against one implementation is premature; extract in Phase 2 from two real targets. |
| 9 | MCP-over-HTTP | **Deferred to Phase 2** | Stateful in-memory MCP sessions don't fit Vercel's stateless serverless (§3.1). |

## 2.5. Prior art: `agentback-demo` on Vercel (the reference)

`agentback-demo` is the concrete pattern Phase 1 codifies. From `api/index.ts`:

- **Memoized async boot, Express leaf.** `appPromise ??= buildExpressApp()`; `handler(req,
  res)` calls `server.expressApp`, typed as a Node `RequestListener` (no `@vercel/node`
  runtime dep). Cold start builds; warm invocations reuse the promise.
- **It imports a builder from a built module** — `buildConsoleApp` from `../dist/console.js`,
  `{listen: false}`. NOT `src/application.ts`. (Drives decision #4.)
- **It deliberately omits `/mcp`** — the entry comment states the Streamable HTTP transport
  is not mounted here. (Consistent with §3.1.)

From `vercel.json`: `buildCommand`, `outputDirectory: public`, `rewrites` all paths to
`/api`, `functions["api/index.ts"].includeFiles` to ship console + `swagger-ui-dist`
assets. **These are demo-specific** (`npm run build`, `public`) — Phase 1 infers the
package manager and does not hardcode them (decision #7).

## 3. Why REST-only, and why MCP waits

### 3.1. Stateful MCP sessions don't fit stateless serverless

`packages/mcp-http/src/index.ts` mounts MCP statefully:

- `:280` — `const transports: Record<string, StreamableHTTPServerTransport> = {}` (in-memory, per-instance).
- `:399` — `sessionIdGenerator: () => randomUUID()` (always stateful; the SDK's stateless mode is `sessionIdGenerator: undefined`).
- `:382-383` — a request whose session id isn't in *this instance's* map → `404 Unknown MCP session`.

Vercel function invocations land on different, short-lived instances that don't share
memory. A client that initializes on instance X and calls a tool on instance Y gets a
404; the GET leg is an SSE stream serverless functions don't hold well. A naive smoke
test (one warm instance, sequential calls) would **pass and hide this**. So Phase 1
deploys REST only. Phase 2 designs MCP-on-serverless properly (stateless transport mode
+ target choice).

### 3.2. Console is opt-in and gated

`packages/console/src/index.ts:80` — `installConsole` refuses to run unauthenticated
without `unsafeAllowUnauthenticated`. The console surfaces the DI container, every
schema, and an MCP inspector. Phase 1 therefore:

- deploys **REST + `/openapi.json` only by default**;
- adds `--console` to opt in, which requires **either** configured auth **or** an explicit
  `--unsafe-public-console` acknowledgement (mirroring the framework's own gate).

## 4. CLI shape

New workspace package **`@agentback/cli`** at `packages/cli/`.

```jsonc
// packages/cli/package.json (excerpt)
"bin": { "agentback": "dist/cli.js", "abc": "dist/cli.js" }
```

- Dependency: `@clack/prompts` (consistent with `create-agentback`).
- Hand-rolled argument parser — one verb does not justify a command framework.

```
agentback deploy vercel [options]

  --entry <path>             built module exporting the app builder
                             (default: detect dist/console.js | dist/main.js | …)
  --export <name>            builder export name
                             (default: detect buildApp | buildConsoleApp)
  --name <n>                 Vercel project/service name (default: package.json "name")
  --prod                     production deploy (default: preview)
  --console                  also deploy the dev console (requires auth or
                             --unsafe-public-console)
  --unsafe-public-console    acknowledge publishing console internals unauthenticated
  --eject                    write api/index.ts + vercel.json to repo root, STOP
                             (do not deploy)
  --force                    overwrite conflicting vercel.json keys
  --dry-run                  generate + preflight only, never shell out (CI-safe)
  --yes                      non-interactive (assume defaults, no prompts)
```

(No `--env` in Phase 1 — deferred, §12. No `--edge`/`--bundle-assets`/`--skip-mcp-check`
— Phase 2.)

## 5. The deploy pipeline

```
detect → generate → preflight → deploy → verify
```

1. **Detect.** Resolve the build entry: `--entry`/`--export`, else detect an exported
   builder (`buildApp`/`buildConsoleApp`) from a conventional built module. If none is
   found, **fail with an actionable error** naming the `--entry`/`--export` contract — never
   guess app wiring. Determine whether `--console` is requested and enforce the §3.2 gate.
2. **Generate.** Write two files at **repo root**:
   - `api/index.ts` — inline-templated, memoized async boot, Node-`RequestListener`-typed
     (decision #5/#6), importing the resolved builder.
   - `vercel.json` — idempotent order-aware merge (§6). Infer the package manager; leave
     `buildCommand` alone when unsure; set `includeFiles` only for the assets the chosen
     surface actually needs (console assets only when `--console`).
   `--eject` stops here and prints next steps.
3. **Preflight.** Verify the `vercel` CLI is installed, authenticated, and the project is
   linked. Never auto-install; print the exact `npm i -g vercel` / `vercel login` /
   `vercel link` command on a miss. (`--dry-run` stops after this stage.)
4. **Deploy.** Shell out to `vercel deploy` (`--prod` when requested), streaming output.
5. **Verify (acceptance gate).** GET the app's **actual** OpenAPI path (detect a custom
   `openApiSpec.path`/`basePath`; allow optional auth headers) on the returned URL.
   `200` → `PASS`; non-200 → `FAIL` with the response body.

## 6. `vercel.json` merge semantics

```
no vercel.json            → write canonical (PM-inferred, no hardcoded build/public)
existing, no conflict     → merge required keys, preserve all others, re-runnable no-op
existing, rewrites present → rewrites is ORDERED: a catch-all can steal/miss routes.
                             FAIL with a clear conflict message unless --force or --eject.
existing, key conflict    → warn + skip that key unless --force
```

The file is the user's; a routine redeploy must never silently drop their keys or reorder
their `rewrites`.

## 7. Generated `api/index.ts` (shape)

```ts
// generated by `agentback deploy vercel`; safe to --eject and edit
import type {IncomingMessage, ServerResponse} from 'node:http';
import {<export>} from '<entry>';   // resolved builder, e.g. buildApp

let booted: Promise<(req: IncomingMessage, res: ServerResponse) => void> | undefined;
const app = () => (booted ??= (async () => {
  const a = await <export>({listen: false});
  const server = await a.restServer;
  return server.expressApp as unknown as (req: IncomingMessage, res: ServerResponse) => void;
})());

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  (await app())(req, res);
}
```

Memoized so the app builds once per cold start; warm invocations reuse the promise. No
`@vercel/node` import — an Express app is a Node `RequestListener`.

## 8. Testing strategy

- **Unit / snapshot (default CI, no creds):**
  - `generateEntry` — snapshot per resolved (entry, export); REST-only vs `--console`.
  - `generateConfig` — fresh write; existing file keys preserved; **rewrites conflict →
    fail unless `--force`/`--eject`**; PM inference; no hardcoded `buildCommand`.
  - arg parse — each flag; unknown/missing target; `--console` without auth/unsafe → error.
  - detect — builder found; **builder missing → actionable error**; console-gate enforcement.
  - preflight — CLI absent / not authed / not linked → each prints its actionable hint.
  - `--dry-run` — asserts **no shell-out** occurs.
  - verify — 200 → PASS; non-200 → FAIL with body; custom OpenAPI path honored.
- **One opt-in, credential-gated e2e:** a real `vercel deploy` of a fixture app, asserting
  the OpenAPI path returns 200. NOT in default CI; runnable on demand and as a pre-release
  gate.

## 9. Failure modes

| Codepath | Realistic failure | Test? | Error handling | User sees |
|---|---|---|---|---|
| detect | no resolvable builder | unit | actionable error naming `--entry`/`--export` | clear message |
| generate | `vercel.json` rewrites conflict | unit | fail unless `--force`/`--eject` | clear conflict + how to override |
| generate | `--eject` over an existing `api/index.ts` | unit | refuse without `--force` (don't clobber user file) | clear message |
| preflight | vercel CLI missing / not authed / project not linked | unit | exact install/login/link hint | clear message |
| deploy | first deploy not linked → interactive prompt | — | honor `--yes`/`--name`; surface link step | guided, not a hang |
| verify | OpenAPI behind auth / custom path / non-200 | unit | detect path + optional headers; FAIL with body | PASS/FAIL + reason |

No flagged **critical gap** (no path is simultaneously untested, unhandled, and silent).

## 10. What already exists (reuse, not rebuild)

- **`agentback-demo`** `api/index.ts` + `vercel.json` — the proven pattern Phase 1 codifies.
- **`create-agentback`** `scaffold.ts` — `detectPackageManager()` is the one helper worth
  reusing (lift to a shared spot if needed); the dir-copy engine is NOT reused (Phase 1
  emits 2 files via inline literals).
- **`@agentback/mcp-http`** `mountMcpHttp` / `mountMcpHttpFetch` — exist, but MCP is Phase 2.
- **`@agentback/mcp-client`** — the remote MCP smoke client for Phase 2 (not hand-rolled JSON-RPC).

## 11. Build sequence (for the implementation plan)

1. `@agentback/cli` skeleton: bins (`agentback`/`abc`), arg parser, `deploy vercel`
   command shell, `--dry-run`.
2. Detect: resolve `--entry`/`--export` or detected builder; console-gate enforcement;
   actionable errors.
3. Generate: inline `api/index.ts` (Node-typed, memoized) + order-aware idempotent
   `vercel.json` merge (PM-inferred). `--eject`.
4. Preflight (`vercel` installed/authed/linked) + deploy (shell `vercel deploy`) + verify
   (actual OpenAPI path → 200).
5. Unit/snapshot suite + one opt-in credential-gated e2e. Docs.

## 12. NOT in scope (deferred to Phase 2 — separate spec)

| Deferred | Why |
|---|---|
| **Cloudflare Workers / Deno Deploy** | Edge isolates: fetch-handler leaf, bundle doctor (`nodejs_compat`, tree-shaking), `compatibility_flags`. Unproven, isolate-specific. |
| **Live MCP-over-HTTP on serverless** | Needs a stateless MCP transport mode (`sessionIdGenerator: undefined`) + target choice (§3.1). |
| **`AssetSource` (CDN/embed) for disk-served UIs** | Only matters where there's no filesystem (edge); Vercel Node has one + `includeFiles`. |
| **`DeployTarget` interface** | Extract from two real targets in Phase 2, not designed against one. |
| **`--env`/secret forwarding** | Build-vs-runtime-vs-local semantics ambiguous; not needed for Phase 1 acceptance. |
| **`agentback.config.ts` deploy block; other CLI verbs; domain/DNS** | Add when the need is real. |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean (SCOPE_REDUCED) | 8 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| Outside Voice | `/codex review` | Independent 2nd opinion | 1 | issues_found | 12 raised, 9 folded, 0 open |

- **CODEX:** found 12 missed issues; the load-bearing 6 (root-discovery, fake app-detect contract, public-console security, `@vercel/node` dep, ordered-`rewrites` merge, custom OpenAPI path) verified against code and folded. Drove the cut to REST-only + explicit entry contract + dropping the `DeployTarget` abstraction.
- **CROSS-MODEL:** Review kept the `DeployTarget` interface; Codex called it premature. User accepted Codex — deferred to Phase 2. Otherwise no disagreement.
- **VERDICT:** ENG CLEARED (SCOPE_REDUCED to Phase 1) — ready to implement once the spec is committed.

NO UNRESOLVED DECISIONS
