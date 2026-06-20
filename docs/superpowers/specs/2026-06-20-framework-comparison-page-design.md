# Design: "Coming from another framework?" comparison page

Status: approved (2026-06-20)

## Goal

Give users of popular TypeScript backend frameworks — **LoopBack 4, NestJS,
tRPC, ts-rest, Hono** — a single page on agentback.dev that shows what carries
over to AgentBack and what they gain. This generalizes the "successor to
LoopBack" instinct into a broader, lower-risk appeal: LoopBack becomes one row
in a table rather than the brand, so AgentBack captures heritage/SEO traffic
without inheriting LoopBack's "legacy IBM-era Node" perception
(`docs/proposals/oss-positioning.md` §6).

This aligns with `oss-positioning.md` §5, which already calls for a comparison
page and migration guides; it folds LoopBack back into that list since LB4 is
the one framework AgentBack shares DI semantics with (`README.md` — "if you
know LB4 DI, you already know this").

## Non-goals

- No per-framework deep-dive migration pages (deferred; this is the single-page
  first step).
- No MCP-native frameworks (FastMCP, xmcp, …), unopinionated base (Express,
  Fastify), or long-tail (oRPC, Elysia, Encore.ts) rows in this version.
- No benchmark/LoC numbers (that is a separate, data-backed asset).
- No framework-feature changes: this is positioning content, so no package
  README / `docs/packages.md` / SKILL.md updates.

## Approach

The page is a **markdown file**, not hand-authored HTML. `website/build.mjs` is
explicit that "Markdown stays the single source of truth — nothing is duplicated
here": docs pages are `.md` files registered in `DOC_PAGES` + `NAV_SECTIONS`,
and the build renders them into the doc shell, emits a `.md` twin, and folds
them into `llms.txt`, `llms-full.txt`, and `sitemap.xml`. Authoring the
comparison as markdown therefore reaches human readers, agents, and crawlers in
one step. `marked` runs with `gfm: true`, so a GitHub-flavored markdown table
renders natively.

A clean top-level `/compare` URL (vs `/docs/compare.html`) would require a small
`mapTarget` change in `build.mjs`; it is **out of scope** for this version.

## Artifacts

### 1. New page: `docs/compare.md`

- **H1:** `Switching to AgentBack`
- **Nav label** (in the sidebar): `Coming from another framework?`
- **Structure:**
  1. **Frame paragraph** — AgentBack isn't a faster router or another MCP
     library; it's one Zod schema → REST + OpenAPI 3.1 + MCP tools + typed
     client + tests, with real dependency injection. If you're coming from one
     of the frameworks below, here's what carries over and what you gain.
  2. **Comparison table** (GFM):

     | Coming from | What carries over | What you gain |
     |---|---|---|
     | **LoopBack 4** | DI instincts — `@inject`, `@injectable`, `Context`, binding scopes, extension points map 1:1 | Zod-first schemas, MCP tools, OpenAPI 3.1 emitted from the same Zod, ESM/Node 22, no `@loopback/repository` baggage |
     | **NestJS** | Decorators + a DI container | One Zod-on-decorator source instead of `nestjs-zod` + `@nestjs/swagger` + a community MCP-Nest across two metadata systems |
     | **tRPC** | No-codegen typed client | Your API is *also* public OpenAPI 3.1 and MCP — first-class, not a lossy add-on; plus a DI container |
     | **ts-rest** | Contract-first discipline | MCP tools + a DI container from the same contract |
     | **Hono** | — | Three libraries (`@hono/zod-openapi` + `@hono/mcp` + hand-written SDK tools) collapse to one process, one schema |

  3. **Five short sections**, one per row (2–4 sentences each), expanding the
     "why," each ending with the CTA `npm create agentback`.

- **Tone principle (binding):** charitable and factual — "what you keep / what
  you gain," never "they're dead" or "they're bad." In particular:
  - **No "ts-rest is abandoned" claim.** Positive framing only.
  - **No "we beat Hono on speed" claim.** AgentBack does not claim fastest
    router (`oss-positioning.md` §2); the Hono story is consolidation, not
    speed.
  - The LoopBack row is the strongest and most honest — it is the only row
    where DI semantics are literally shared.

### 2. `website/build.mjs` wiring

- Add `'docs/compare.md'` to the `DOC_PAGES` array.
- Add a nav entry to the **Start** group in `NAV_SECTIONS`:
  `['docs/compare.md', 'Coming from another framework?']`.

No other build changes. `llms.txt`, `llms-full.txt`, and `sitemap.xml` pick the
page up automatically.

### 3. `website/index.html` (hand-edited homepage — minimal)

- Add a **"Compare"** link to the `nav-links` row in the header.
- Add one hero line under the lede linking to the page, e.g.:
  *"Coming from LoopBack, NestJS, tRPC, ts-rest, or Hono? →"* pointing at
  `docs/compare.html`.

No dedicated homepage band/section beyond these two links.

## Verification

- `node website/build.mjs` (or the repo's website build command) succeeds and
  emits `website/dist/docs/compare.html` + `website/dist/docs/compare.md`.
- The page appears in `website/dist/sitemap.xml` and as an entry under "Start"
  in `website/dist/llms.txt`.
- The rendered table displays as an HTML `<table>` (gfm), and the sidebar shows
  "Coming from another framework?" under Start with `aria-current` on the page
  itself.
- The homepage (`website/dist/index.html`) shows the "Compare" nav link and the
  hero line, both resolving to `docs/compare.html`.
- Every "what you gain" claim is checked against the codebase / `README.md` /
  `oss-positioning.md` for accuracy; the two forbidden claims (ts-rest
  abandoned, Hono speed) are absent.

## Risks

- **Claim accuracy.** Comparison pages invite "well actually" rebuttals. Mitigate
  by keeping each claim to verifiable, framework-architecture facts (number of
  libraries / metadata systems / presence of DI), not performance or liveness
  judgments.
- **Staleness.** Competitor frameworks evolve (e.g. a framework adds an MCP
  adapter). Accept for now; the page is small and easy to revise. No automated
  freshness mechanism in this version.
