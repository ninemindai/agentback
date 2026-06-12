# Proposal: OSS positioning — making AgentBack the agent-native API framework for TypeScript

Status: draft (2026-06-11) — L-1 through L-4 implemented 2026-06-11:
L-1 (`/llms.txt` + `/llms-full.txt` served by RestServer, `generateAgentContext`,
`AX_SECTION_TAG` with the MCP section contributed by `installMcpHttp`);
L-2 (machine-actionable error envelope — stable `code`, `issues`, violated
`schema`, `retryable`, `hint` — shared by REST `sendError` and MCP tool
errors via `buildErrorEnvelope` in `@agentback/openapi`);
L-3 (`MCPServer.toolCostReport()` + `formatToolCostReport` token-pricing of
the tool surface); L-4 (`confirm:` on routes and `@tool`s with single-use
payload-bound tokens, `idempotency:` on routes with pluggable stores —
`RestBindings.CONFIRMATION_STORE`/`IDEMPOTENCY_STORE`,
`MCPBindings.CONFIRMATION_STORE`). L-5 implemented 2026-06-11: `@price`
decorator in `@agentback/metering` (dispatch hooks stamp `cost`/`units`
onto usage events; `StripeMeterSink` already forwards them),
`installPriceGate` in `@agentback/payments` (REST + MCP dispatch hooks,
402 `payment_required` envelope with the rail challenge, `@price` flows into
`PaymentContext.price` so rail requirements derive from the decorator),
hello-x402 rewritten around it, blog post "Charge agents per call". L-6
resolved 2026-06-11: P1-2 and P1-3 were verified already implemented in code
(low-level tool registration with Standard Schema; mcp-host prompts/resources
aggregation with URI routing); the MCP Apps design doc landed as
[P1-6](p1-6-mcp-apps.md) (SEP-1865 went Final 2026-01-26 — phase 1 is
shippable, the typed view bridge is the differentiator). The launch playbook
remains.
Inputs: full codebase survey + competitive research across the MCP framework
landscape (FastMCP py/ts, xmcp, mcp-framework, mcp-use, Cloudflare Agents SDK,
Smithery/Glama/Composio/Speakeasy/Stainless) and the TS API framework landscape
(Hono, tRPC, oRPC, Fastify, NestJS, Elysia, Encore.ts, ts-rest).

## 1. The market gap, stated precisely

As of June 2026, **no TypeScript framework derives REST routes and MCP tools
from one schema declaration in one process with real dependency injection.**

- Hono needs three separate libraries (`@hono/zod-openapi`, `@hono/mcp`,
  hand-written SDK tools) with three separate schema declarations.
- tRPC/oRPC are RPC-first; oRPC chose Vercel AI SDK tools over MCP and has no
  MCP adapter. Neither has a DI container.
- NestJS has the DI but needs three community add-ons (`nestjs-zod`,
  `@nestjs/swagger`, `@rekog/mcp-nest`) across two metadata systems.
- xmcp / fastmcp-ts / mcp-framework / mcp-use are MCP-only — no REST duality,
  no OpenAPI, no DI.
- Speakeasy/Stainless generate MCP from OpenAPI — a lossy, separately-maintained
  artifact; even Speakeasy admits 1:1 endpoint→tool mapping produces bad tools.

The demand proof is Python-side: **FastAPI-MCP (11.9k stars)** sells exactly
this pitch — one codebase serves REST and MCP, auth flows through FastAPI's
`Depends()` DI — and it has stalled (last release Jul 2025). FastMCP's
`from_fastapi()` validates the same direction. The TS seat is empty.

AgentBack already occupies that seat. The work now is sharpening the
story, closing a small number of capability gaps that the agent-era discourse
rewards, and executing a launch playbook.

## 2. Positioning

**Tagline:** _One schema, every boundary._ Write a Zod schema once on a
decorator; it becomes your validator, your TypeScript type, your OpenAPI 3.1
document, your MCP tool contract, your typed client, and your docs — with the
same `@authorize` policy governing the human surface and the agent surface.

**Category:** the agent-native API framework for TypeScript. Not "an MCP
framework" (crowded: fastmcp, xmcp, tmcp) and not "a fast router" (owned by
Hono/Elysia). The category claim is: _your API is one artifact consumed by
apps, humans, and agents, and the framework keeps all three views coherent._

**Elevator comparisons:**

- "FastAPI's Pydantic ergonomics, in TypeScript, with MCP built in."
- "What NestJS + nestjs-zod + @nestjs/swagger + MCP-Nest tries to be, as one
  coherent system instead of four metadata layers."
- "tRPC's no-codegen typed client, but your API is also public OpenAPI and MCP."

**What we do NOT claim:** fastest router, edge-first runtime, agent
orchestration framework (Mastra/LangGraph territory), API gateway.

## 3. What is already differentiated (protect, don't rebuild)

Confirmed unique or near-unique after the competitive sweep:

1. **Boundary coherence with compile-time enforcement** — slot-0
   `TypedPropertyDescriptor` constraints; OpenAPI 3.1.1 emitted from the same
   Zod that types the handler; MCP `inputSchema`/`outputSchema` from the same
   source. No incumbent can retrofit this without rearchitecting.
2. **Unified `@authorize` across REST routes and MCP tool visibility/dispatch**
   (P0-1). MCP-side per-tool policy is the #1 enterprise ask in the 2026 MCP
   roadmap discourse; nobody else has it as a framework primitive.
3. **DI-driven auth/multi-tenancy** — the FastAPI `Depends()` advantage that no
   TS MCP framework replicates (Cloudflare gets closest, with vendor lock-in
   and a history of cross-client leakage bugs).
4. **Schema-shared typed client with zero codegen** and no server-package
   runtime dependency (browser-safe).
5. **Metering + payments seams in the dispatch path** (`metering`, `payments`,
   x402/MPP/Stripe rails). Today this market is served entirely by external
   proxies (Toll, Nevermined, mcp-billing-gateway, Zuplo); no framework owns it.
6. **Typed streaming** (`streamOf:` with per-item Zod validation, OpenAPI 3.2
   `itemSchema`, typed client SSE consumption).
7. **Embedded MCP inspector + console** — in-process, not a separate CLI.

## 4. Capability proposals (pre-launch)

Ordered by leverage. L-numbers to keep them distinct from the P-series.

### L-1: Ship-your-own-AX — the framework that documents itself to agents

`app.start()` already serves `/openapi.json`, `/explorer`, `/mcp`,
`/mcp-inspector`. Complete the set:

- **`/llms.txt` + `/llms-full.txt`** generated from the same route/tool
  registry (titles + descriptions from Zod `.describe()` / decorator metadata).
- **Generated agent context file** — a CLI (`AgentBack agent-context`) or
  endpoint that emits a CLAUDE.md/skill-file describing the live API: routes,
  tools, auth requirements, error contract. "Your API's first consumer is an
  agent; hand it the manual automatically."
- **Docs MCP server for the framework itself** + Context7 indexing + llms.txt
  on the docs site. In 2026, being well-represented in Context7/docs-MCP _is_
  distribution — the agent scaffolding a new service picks the framework it can
  retrieve docs for.

Cheap (the registry already holds everything), and it makes the meta-story
("built for AI-led development") self-demonstrating.

### L-2: Agent-grade error contract (machine-actionable failures)

The recurring AX requirement nobody ships as a framework default: errors an
agent can self-correct from. Standardize the REST and MCP error envelope:

- Zod issue path + expected schema fragment + a `retryable` flag + remediation
  hint in every validation failure.
- Stable machine-readable error codes across REST (problem+json shape) and MCP
  (tool error content).
- Benchmarkable claim: "agents self-correct in 1 retry vs N against
  Express/raw SDK." Quantify it with a small harness — a measurable AX number
  is a launch asset nobody else has published.

### L-3: Context-budget governance (attack the #1 MCP complaint)

Context bloat is the defining 2026 critique (Anthropic's 134K-token tool
definitions; Perplexity's "72% context tax"). Position AgentBack as the
framework that treats tool-definition tokens as a budget:

- **`pnpm exec AgentBack toolcost`** (or a console panel): token-count
  every tool definition, flag the bloated ones, total the `tools/list` cost.
- **Curated toolsets**: first-class grouping/filtering so a server exposes a
  small, task-shaped tool surface instead of every route (`@tool` opt-in
  already does this — make it a documented design stance: _tools are not
  endpoints_).
- (Later) a code-execution surface à la Stainless/Anthropic's
  "code execution with MCP" — the typed client is the natural substrate: hand
  the agent a sandboxed typed client instead of N tools.

### L-4: Safety primitives for handing APIs to agents

Directly answers the "is this safe to give an agent?" discourse:

- **`@confirm`** on dangerous mutations → MCP elicitation / 409-with-
  confirmation-token on REST.
- **Idempotency keys** as a decorator option on mutations (header contract +
  dedupe seam, storage pluggable via DI).

Both are small, decorator-shaped, and headline-friendly.

### L-5: `@price` / metering polish — "monetize your MCP server in one decorator"

The seams exist (`metering`, `payments`, hello-x402). Package the story:

- A `@price('$0.001')`-style sugar decorator that wires metering + payment rail
  for a route/tool.
- Stripe usage-event sink reference impl next to the x402 rail (Stripe MPP and
  agent-toolkit are where real money is; x402 organic volume is still tiny).
- One example + one blog post. This is a guaranteed HN-headline capability and
  no framework has it natively.

### L-6: Finish P1-2 (Standard Schema) and P1-3 (MCP suite completion)

Standard Schema acceptance is table-stakes in 2026 (official SDK, Mastra,
fastmcp-ts all take Zod/Valibot/ArkType). Resources/prompts aggregation and
PROGRESS bindings round out spec completeness. Also worth tracking: MCP Apps
(interactive tool UI) is the emerging wave — FastMCP 3 and mcp-use are both
chasing it; a design doc now, implementation post-launch.

## 5. Launch playbook

1. **The 60-second demo** (the asset everything else links to): one controller
   file → `curl /openapi.json`, Swagger UI, typed client call, then connect
   Claude Code/ChatGPT to the same process over `/mcp` and watch it call the
   same method under the same `@authorize` policy. No other TS stack can show
   this without three libraries. End on the metering console counting the
   agent's calls.
2. **Docs gaps to close first** (from the codebase survey): CONTRIBUTING.md,
   deployment guide (container/K8s probes/12-factor config/OTel exporter
   wiring), MCP-auth wiring guide (OAuth → tools, step by step), testing guide.
   Clarify copyright headers emitted by `create-agentback` scaffolds.
3. **Benchmark + LoC comparison page** (the oRPC playbook): lines of code and
   number of libraries to reach REST + OpenAPI 3.1 + MCP + typed client parity
   vs Hono-stack, NestJS-stack, tRPC+adapters; plus typecheck/runtime overhead
   numbers so the DI tax is answered with data, not vibes.
4. **Migration guides** from tRPC, ts-rest (maintenance-limbo refugees), and
   NestJS — the highest-converting page type in this category.
5. **Distribution through agents**: Context7 indexing, docs MCP server,
   llms.txt, published agent skill file — at launch, not after.
6. **Registry presence**: publish example servers to the official MCP registry
   (server.json) and Smithery/Glama so the framework name appears where MCP
   authors browse.
7. **Show HN + 3-post blog series**: (a) boundary coherence thesis (exists,
   docs/agent-ergonomics.md — tighten for external audience), (b) "tools are
   not endpoints" / context-budget post, (c) "charge agents per tool call"
   post. Each anchored to a runnable example.
8. **Deploy story**: one-command Dockerfile in the scaffold + Railway/Fly
   buttons. (Vercel/Workers are constrained by the Express ^4 + long-lived
   process shape — don't over-claim edge support; Cloudflare's lock-in is our
   talking point, not our target runtime.)

## 6. Risks and honest weaknesses

- **Brand**: "LoopBack" reads as legacy IBM-era Node to much of the 2026 TS
  audience, and "agent" suffix collides with agent-orchestration frameworks.
  Worth a deliberate naming decision before the public launch — keep (heritage
  - SEO from LB4 users) vs. rename (clean agent-native identity). Decide once;
    renaming after launch is far more expensive.
- **Decorators + classes + DI** are countercultural next to Hono/oRPC's
  functional minimalism. Counter with the benchmark/LoC page and with the
  agent-ergonomics argument (precise, localized failure signals), not with
  defensiveness. The experimental-decorators dependency (P0-3b deferred) will
  come up in every HN thread — have the TC39 migration plan linked and honest.
- **Express ^4 underneath** invites "why not Hono/h2" — the dispatch seam is
  subclassable and the answer is "boring, stable, swappable"; an adapter story
  is a credible post-launch roadmap item.
- **FastMCP/Prefect** owns the category narrative and could ship a serious TS
  port; **xmcp+Vercel** could add REST duality; **Mastra** absorbs "my agent
  framework already does MCP" demand. Speed-to-narrative matters more than
  feature count: claim "agent-native API framework for TypeScript" publicly
  before someone else does.
- **Pre-alpha honesty**: keep the "API still moving" banner until the decorator
  surface survives one external-user cycle; nothing kills a launch like a
  breaking change the week after Show HN.

## 7. Suggested sequencing

1. L-1 (AX artifacts) + L-2 (error contract) + docs gaps — small, high-leverage,
   all pre-launch.
2. L-5 (@price sugar + Stripe sink) + L-4 (@confirm/idempotency) — the two
   headline features.
3. Benchmark/LoC page + migration guides + 60-second demo.
4. Launch (Show HN, registries, Context7).
5. Post-launch: L-3 deepening (code-exec surface), MCP Apps design, P1-2/P1-3
   completion, Express 5 / adapter exploration.
