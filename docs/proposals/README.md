# Proposals

Design proposals for the P0/P1 roadmap derived from the FastAPI/NestJS
comparison (2026-06). Each is a self-contained design doc; statuses are
tracked in the doc headers.

## P0 — close gaps, deepen the wedge

| #     | Proposal                                                  | One-liner                                                                                                                  |
| ----- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| P0-1  | [Unified policy layer](p0-1-unified-policy-layer.md)      | One `@authorize` declaration governs REST routes and MCP tool visibility + dispatch                                        |
| P0-2  | [Typed streaming](p0-2-typed-streaming.md)                | `streamOf:` on verb decorators — SSE with per-item Zod validation, OpenAPI `itemSchema`, typed client consumption          |
| P0-3  | [Standard decorators escape](p0-3-standard-decorators.md) | `static inject` injection form (phase 1) on the road off reflect-metadata/experimentalDecorators                           |
| P0-3b | [TC39 decorators, phases 2–3](p0-3b-tc39-decorators.md)   | Runtime dual-mode metadata machinery (P2, non-breaking) then the flip to standard decorators (P3, breaking) — **deferred** |
| P0-4  | [DX floor](p0-4-dx-floor.md)                              | `@agentback/testing` (`createTestApp`) + `create-agentback` scaffold                                                       |
| P0-5  | [Messaging Layer 2](p0-5-messaging-bullmq.md)             | `@agentback/messaging-bullmq` — durable BullMQ/Redis adapter behind the existing ports                                     |

## P1 — extend the moat

| #    | Proposal                                             | One-liner                                                                                          |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| P1-1 | [Drizzle recipe](p1-1-drizzle-recipe.md)             | Ship `@agentback/drizzle` per [db-story.md](../db-story.md)                                        |
| P1-2 | [Standard Schema compat](p1-2-standard-schema.md)    | Decorators accept any `~standard` schema; JSON-Schema emission stays mandatory                     |
| P1-3 | [MCP suite completion](p1-3-mcp-suite-completion.md) | `mcp-host` resources/prompts aggregation; `REQUEST_EXTRA`/`PROGRESS` bindings for tools            |
| P1-4 | [extension-otel](p1-4-extension-otel.md)             | OpenTelemetry traces across REST, MCP, and jobs — `@opentelemetry/api` only                        |
| P1-5 | [Skill generation](p1-5-skill-generation.md)         | `generateSkill()` + `/skills/<name>/SKILL.md` — derived from the registry, recipes via DI          |
| P1-6 | [MCP Apps](p1-6-mcp-apps.md)                         | Interactive tool UI (SEP-1865): `@tool(..., {ui})`, `@appResource`, typed view bridge — **design** |

## P2 — prerequisites surfaced by review

| #    | Proposal                                     | One-liner                                                         |
| ---- | -------------------------------------------- | ----------------------------------------------------------------- |
| P2-1 | [Publish pipeline](p2-1-publish-pipeline.md) | Manual all-at-once release workflow; gates P0-4's `npm create` UX |

## Exploratory — not part of the reviewed roadmap

| #   | Proposal                              | One-liner                                                                                             |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| E-1 | [Chat channels](chat-channels.md)     | `@agentback/chat` — chat platforms (Slack/Discord/…) as a third inbound surface via Vercel's Chat SDK |
| E-2 | [Circuit breaker](circuit-breaker.md) | `@agentback/extension-circuit-breaker` — outbound fault tolerance; the dual of `extension-rate-limit` |

## Sequencing constraints (from eng review)

- **P0-1 step 0** (per-request context guarantee in `mcp`) must land before
  P0-1's policy wiring and before P1-3 (request extras bind into that context).
- **P0-2 before P1-2** — both rewrite the `RouteInput`/`SuccessReturn` typing
  seam; P1-2's checklist threads `streamOf`.
- **P0-4's `npm create` UX is gated on a publish pipeline** (separate
  prerequisite proposal); the scaffold + testing packages land in-repo now.
- Everything else is independent and parallelizable.

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                             | Runs | Status       | Findings                                                                          |
| ------------- | --------------------- | ------------------------------- | ---- | ------------ | --------------------------------------------------------------------------------- |
| Eng Review    | `/plan-eng-review`    | Architecture & tests (required) | 1    | CLEAR (PLAN) | 18 issues (2 critical, 8 major, 8 minor) — all resolved by doc amendments 2026-06 |
| Outside Voice | adversarial subagent  | Independent 2nd opinion         | 1    | RAN (claude) | findings folded into Eng Review count                                             |
| CEO Review    | `/plan-ceo-review`    | Scope & strategy                | 0    | —            | —                                                                                 |
| Design Review | `/plan-design-review` | UI/UX gaps                      | 0    | —            | —                                                                                 |

**UNRESOLVED:** 0 — all 18 findings decided autonomously (decisions recorded in each proposal's "review note" blocks).
**VERDICT:** ENG CLEARED — ready to implement in the order above.
