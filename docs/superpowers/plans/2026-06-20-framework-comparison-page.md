# Framework Comparison Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single "Coming from another framework?" comparison page to agentback.dev that shows LoopBack 4 / NestJS / tRPC / ts-rest / Hono users what carries over to AgentBack and what they gain.

**Architecture:** The page is authored as one markdown file (`docs/compare.md`) and registered in the website build (`website/build.mjs`), which renders it into the doc shell and auto-includes it in `llms.txt`, `llms-full.txt`, and `sitemap.xml` — markdown stays the single source of truth. The hand-written homepage (`website/index.html`) gets a nav link and one hero line pointing at it.

**Tech Stack:** Node ESM build script (`website/build.mjs`), `marked` (GFM markdown → HTML), static HTML/CSS. No package build script — the site builds via `node website/build.mjs`.

## Global Constraints

- **No unit-test harness for the website.** `vitest` only globs `packages/*/dist`. Verify website changes by running `node website/build.mjs` and asserting on the emitted `website/dist/**` files (grep), as the steps below do.
- **Markdown is the single source of truth.** Author content as `docs/compare.md`; never hand-edit `website/dist/**` (it is regenerated every build). The only hand-edited HTML is `website/index.html`.
- **Docs markdown carries no copyright header.** `docs/*.md` files (e.g. `docs/README.md`) do not carry the three-line source header. Do NOT add one to `docs/compare.md`.
- **Binding tone rules (from the spec):** charitable and factual — "what you keep / what you gain," never "they're dead/bad." Specifically: **no "ts-rest is abandoned" claim**, and **no "AgentBack beats Hono on speed" claim** (AgentBack does not claim fastest router).
- **Commit only source files**, never build output: `docs/compare.md`, `website/build.mjs`, `website/index.html`, `website/styles.css`. Do not `git add website/dist`.
- **Branch:** work happens in the worktree at `.claude/worktrees/feat+framework-comparison-page` (branch `worktree-feat+framework-comparison-page`).

---

### Task 1: Create the comparison page and wire it into the build

**Files:**
- Create: `docs/compare.md`
- Modify: `website/build.mjs` (the `DOC_PAGES` array near line 31; the `NAV_SECTIONS` "Start" group near line 52)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: a built page at `website/dist/docs/compare.html` (+ `.md` twin), a sidebar nav entry "Coming from another framework?" under the **Start** group, and `docs/compare.html` as the homepage's link target consumed by Task 2.

- [ ] **Step 1: Write the page content**

Create `docs/compare.md` with exactly this content:

```markdown
# Switching to AgentBack

AgentBack isn't a faster router or another MCP library. It's one Zod schema
turned into your REST routes, your OpenAPI 3.1 document, your MCP tools, your
typed client, and your runtime validation — served from a single process with a
real dependency-injection container. If you're arriving from one of the
frameworks below, here's what carries over and what you gain.

| Coming from | What carries over | What you gain |
|---|---|---|
| **LoopBack 4** | DI instincts — `@inject`, `@injectable`, `Context`, binding scopes, extension points map 1:1 | Zod-first schemas, MCP tools, OpenAPI 3.1 emitted from the same Zod, ESM/Node 22, no `@loopback/repository` baggage |
| **NestJS** | Decorated classes and a DI container | One Zod-on-decorator source instead of `nestjs-zod` + `@nestjs/swagger` + a community MCP bridge across two metadata systems |
| **tRPC** | A no-codegen, end-to-end-typed client | Your API is *also* a public OpenAPI 3.1 document and MCP tools — first-class outputs, not a bolt-on — plus a DI container |
| **ts-rest** | Contract-first discipline | The same contract becomes MCP tools an agent can call, under one `@authorize` policy, plus a DI container |
| **Hono** | — | `@hono/zod-openapi` + `@hono/mcp` + hand-written SDK tools collapse to one schema, one process |

## From LoopBack 4

AgentBack is an ESM port of LoopBack 4's dependency-injection core, so
`@inject`, `@injectable`, `Context`, binding scopes, and extension points behave
exactly as you remember — if you know LB4 DI, you already know this. What changes
is everything above the container: schemas are Zod, the same Zod emits OpenAPI
3.1 and an MCP tool contract, and the whole thing runs on ESM / Node 22. You
keep the architecture and shed the `@loopback/repository` weight.

`npm create agentback`

## From NestJS

Keep the mental model you like — decorated classes and a DI container — but
collapse the metadata sprawl. Where a Nest stack reaches for `nestjs-zod`,
`@nestjs/swagger`, and a community MCP bridge across two metadata systems,
AgentBack puts one Zod schema on the decorator and derives the validator, the
OpenAPI document, and the MCP tool from it. One source of truth instead of four.

`npm create agentback`

## From tRPC

Your no-codegen, end-to-end-typed client carries straight over: AgentBack's
client imports the same Zod schemas the server validates against, with no
generation step. The difference is reach — your API is also a public OpenAPI 3.1
document and a set of MCP tools, as first-class outputs rather than an add-on —
and you get a DI container for auth and multi-tenancy.

`npm create agentback`

## From ts-rest

The contract-first discipline is the same idea: define the shape once, share it
across client and server. AgentBack extends that contract past REST — the same
schema becomes MCP tools an agent can call, governed by the same `@authorize`
policy that guards your HTTP routes — and gives you a DI container to wire
services and auth.

`npm create agentback`

## From Hono

To reach REST + OpenAPI 3.1 + MCP + a typed client on Hono you assemble several
libraries — `@hono/zod-openapi`, `@hono/mcp`, and hand-written SDK tools — each
with its own schema declaration. AgentBack delivers the same surface from one
schema in one process. (Hono is an excellent edge router; if raw routing speed
is your priority it belongs on your list — AgentBack's pitch is consolidation,
not benchmarks.)

`npm create agentback`
```

- [ ] **Step 2: Register the page in `DOC_PAGES`**

In `website/build.mjs`, find the `DOC_PAGES` array and add `'docs/compare.md'`
immediately after the `'docs/README.md',` entry.

Replace:

```js
const DOC_PAGES = [
  'docs/README.md',
  'docs/concepts/dependency-injection.md',
```

with:

```js
const DOC_PAGES = [
  'docs/README.md',
  'docs/compare.md',
  'docs/concepts/dependency-injection.md',
```

- [ ] **Step 3: Add the sidebar nav entry under "Start"**

In `website/build.mjs`, find the `NAV_SECTIONS` "Start" group.

Replace:

```js
  {
    title: 'Start',
    items: [['docs/README.md', 'Documentation index']],
  },
```

with:

```js
  {
    title: 'Start',
    items: [
      ['docs/README.md', 'Documentation index'],
      ['docs/compare.md', 'Coming from another framework?'],
    ],
  },
```

- [ ] **Step 4: Build the site**

Run: `node website/build.mjs`
Expected: prints `built website/dist — homepage, 18 docs pages, blog, diagrams` (the count rises from 17 to 18).

- [ ] **Step 5: Assert the page and its derived artifacts exist**

Run:

```bash
test -f website/dist/docs/compare.html && \
test -f website/dist/docs/compare.md && \
grep -q "<table>" website/dist/docs/compare.html && \
grep -q "Coming from another framework?" website/dist/docs/index.html && \
grep -q "compare" website/dist/sitemap.xml && \
grep -q "Coming from another framework?" website/dist/llms.txt && \
echo "ALL CHECKS PASS"
```

Expected: `ALL CHECKS PASS`. (The table renders as an HTML `<table>`; the sidebar nav entry appears in the doc shell of every docs page; the page is in the sitemap and llms.txt index.)

- [ ] **Step 6: Confirm forbidden claims are absent**

Run:

```bash
grep -niE "abandoned|dead|unmaintained|faster than|fastest|beats hono" docs/compare.md || echo "NO FORBIDDEN CLAIMS"
```

Expected: `NO FORBIDDEN CLAIMS`.

- [ ] **Step 7: Commit**

```bash
git add docs/compare.md website/build.mjs
git commit -m "feat(website): add 'Coming from another framework?' comparison page"
```

---

### Task 2: Link the page from the homepage

**Files:**
- Modify: `website/index.html` (the `.nav-links` block near line 43; the hero, after the `.hero-actions` div near line 81)
- Modify: `website/styles.css` (add a `.hero-switch` rule after the `.hero-status` rule near line 267)

**Interfaces:**
- Consumes: `docs/compare.html` (built by Task 1) as the link target.
- Produces: nothing consumed by later tasks (final task).

- [ ] **Step 1: Add the "Compare" header nav link**

In `website/index.html`, replace:

```html
        <div class="nav-links">
          <a href="docs/index.html">Docs</a>
          <a href="docs/guides/build-a-rest-api.html">Guides</a>
          <a href="blog/index.html">Blog</a>
```

with:

```html
        <div class="nav-links">
          <a href="docs/index.html">Docs</a>
          <a href="docs/guides/build-a-rest-api.html">Guides</a>
          <a href="docs/compare.html">Compare</a>
          <a href="blog/index.html">Blog</a>
```

- [ ] **Step 2: Add the hero line under the call-to-action buttons**

In `website/index.html`, replace:

```html
          <div class="hero-actions reveal d3">
            <a class="button" href="docs/index.html">Read the docs</a>
            <a
              class="button secondary"
              href="https://github.com/ninemindai/agentback"
            >
              ninemindai/agentback
            </a>
          </div>
          <p class="hero-status reveal d3">
```

with:

```html
          <div class="hero-actions reveal d3">
            <a class="button" href="docs/index.html">Read the docs</a>
            <a
              class="button secondary"
              href="https://github.com/ninemindai/agentback"
            >
              ninemindai/agentback
            </a>
          </div>
          <p class="hero-switch reveal d3">
            Coming from LoopBack, NestJS, tRPC, ts-rest, or Hono?
            <a href="docs/compare.html">See what carries over →</a>
          </p>
          <p class="hero-status reveal d3">
```

- [ ] **Step 3: Add the `.hero-switch` style**

In `website/styles.css`, find the `.hero-status` rule (ends with its closing
brace before the `.status-dot` rule) and insert the new rule immediately after
it.

Replace:

```css
.hero-status {
  align-items: center;
  color: var(--muted);
  display: flex;
  font-family: var(--mono);
  font-size: 12.5px;
  gap: 8px;
  margin: 26px 0 0;
}

.status-dot {
```

with:

```css
.hero-status {
  align-items: center;
  color: var(--muted);
  display: flex;
  font-family: var(--mono);
  font-size: 12.5px;
  gap: 8px;
  margin: 26px 0 0;
}

.hero-switch {
  color: var(--muted);
  font-size: 14px;
  margin: 18px 0 0;
}

.status-dot {
```

- [ ] **Step 4: Build the site**

Run: `node website/build.mjs`
Expected: prints `built website/dist — homepage, 18 docs pages, blog, diagrams`.

- [ ] **Step 5: Assert the homepage links and style are present**

Run:

```bash
grep -q '<a href="docs/compare.html">Compare</a>' website/dist/index.html && \
grep -q 'class="hero-switch reveal d3"' website/dist/index.html && \
grep -q 'See what carries over' website/dist/index.html && \
grep -q '.hero-switch {' website/dist/styles.css && \
echo "HOMEPAGE LINKS PASS"
```

Expected: `HOMEPAGE LINKS PASS`.

- [ ] **Step 6: Commit**

```bash
git add website/index.html website/styles.css
git commit -m "feat(website): link the comparison page from the homepage hero and nav"
```

---

## Self-Review

**Spec coverage:**
- New page `docs/compare.md` with H1 "Switching to AgentBack", frame paragraph, GFM table, five per-row sections each ending in `npm create agentback` → Task 1, Step 1. ✓
- Nav label "Coming from another framework?" under Start → Task 1, Step 3. ✓
- `build.mjs` wiring (`DOC_PAGES` + `NAV_SECTIONS`) → Task 1, Steps 2–3. ✓
- Auto-inclusion in `llms.txt` / `sitemap.xml` → verified in Task 1, Step 5. ✓
- Homepage "Compare" nav link + one hero line, minimal (no band/section) → Task 2, Steps 1–3. ✓
- Tone rules / forbidden claims → Global Constraints + Task 1, Step 6 grep. ✓
- Verification (build emits page, table is `<table>`, sitemap/llms entry, homepage links) → Task 1 Step 5, Task 2 Step 5. ✓

**Placeholder scan:** No TBD/TODO; every code/markdown block is complete; every command has expected output. ✓

**Type/identifier consistency:** `docs/compare.md` → `docs/compare.html` mapping is consistent across both tasks; nav label string "Coming from another framework?" identical in Task 1 Step 3 and the Task 1 Step 5 assertion; `.hero-switch` class identical in Task 2 Steps 2–3 and Step 5 assertion. ✓
