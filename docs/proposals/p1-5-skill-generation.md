# Proposal P1-5: `generateSkill()` — derive an agent skill from the schema registry

**Status:** Draft (2026-06-11). Closes the
[oss-positioning](oss-positioning.md) launch-playbook item "published agent
skill file" (§5, distribution-through-agents). Builds directly on the shipped
L-1 AX artifacts (`packages/rest/src/ax.ts`); read
[docs/agent-ergonomics.md](../agent-ergonomics.md) first — this proposal is
only viable because it **derives** the skill instead of hand-maintaining one.

## Motivation

Agent skills (Claude Code `SKILL.md` and the converging agents-skills format)
are becoming the unit of distribution for "how to use this tool/API": a
markdown file with `name`/`description` frontmatter that an agent harness
loads by trigger, plus a body of instructions. Today every skill that
describes an HTTP API is hand-written, which means it rots the moment the API
changes — exactly the second-source-of-truth drift this framework exists to
eliminate.

We already generate 90% of a skill. `generateAgentContext()` renders "a
CLAUDE.md / skill-file shape" (its own docstring) from the same route
registry that emits `/openapi.json`, `/llms.txt`, and the MCP tool list. What
is missing is small and mechanical:

1. **Frontmatter** — `name` and a trigger-oriented `description`, the part
   that makes progressive disclosure work in skill harnesses.
2. **A content model that respects context budgets** — skill bodies must be
   compact; inlining every JSON Schema (what `/llms-full.txt` does) blows the
   budget the L-3 work taught us to measure.
3. **A seam for procedural knowledge** — sequencing, auth bootstrap, gotchas.
   Schemas cannot express "create the job, then poll `/jobs/{id}`"; a skill
   that is only a schema dump is reference docs in a skill costume.

The differentiated claim: **a skill that cannot drift**, because the
reference layer is regenerated from the live registry and only the
procedural layer is human-authored — and that layer is contributed through
DI bindings, the same mechanism `@agentback/mcp-http` already uses to
advertise the MCP surface in `/llms.txt`.

## Design

### Two layers, one document

```
---
name: petstore-api            # derived: kebab-case of info.title (overridable)
description: >-               # derived from info.description + auto trigger
  Use when calling the Petstore API (manage pets, orders, inventory).
  Covers REST endpoints at https://api.example.com and MCP tools at /mcp.
---

# Petstore API                ← header()           (derived)
Base URL, spec pointer        ← agent-context head (derived)
## Authentication             ← securitySchemes    (derived)
## Endpoints                  ← compact index, llms.txt-shaped (derived)
## Error contract             ← ERROR_CONTRACT     (derived)
## MCP (Model Context Protocol)  ← existing AX_SECTION_TAG bindings (derived)
## Recipes / Workflows        ← SKILL_SECTION_TAG bindings (authored)
## Reference                  ← pointers to /llms-full.txt + /openapi.json
```

Key content decision: the skill body uses the **compact** endpoint index
(one line per operation, as in `generateLlmsTxt`), not the inlined schemas of
`generateLlmsFullTxt`. The closing Reference section tells the agent where
full schemas live (`/llms-full.txt`, `/openapi.json`). This is progressive
disclosure done the way skills are supposed to do it — the skill teaches; the
endpoints serve the heavy detail on demand.

### API surface

All in `packages/rest/src/ax.ts` (same module, same registry, same
conventions):

```ts
export interface SkillOptions extends AgentContextOptions {
  /** Frontmatter `name`. Default: kebab-case of the spec's `info.title`. */
  name?: string;
  /**
   * Frontmatter `description` — the trigger line. Default: a sentence
   * synthesized from `info.title` + first line of `info.description` +
   * the served surfaces ("REST endpoints at <baseUrl>", "MCP tools at
   * <mcpPath>" when contributed).
   */
  trigger?: string;
  /** Authored procedural sections appended before the Reference block. */
  recipes?: AxSection[];
}

/** Render a SKILL.md document (frontmatter + body) for this API. */
export function generateSkill(spec: OpenApiSpec, opts?: SkillOptions): string;
```

```ts
// Emit at build/deploy time, commit next to consumer code:
const spec = await server.getApiSpec();
await fs.writeFile(
  '.claude/skills/petstore-api/SKILL.md',
  generateSkill(spec, {baseUrl, recipes: [orderWorkflow]}),
);
```

### Serving: `/skills/<name>/SKILL.md`

`mountAxRoutes()` grows a third route, `GET /skills/<name>/SKILL.md`
(text/markdown, `<name>` = the frontmatter name), served by default
alongside `/llms.txt` and `/llms-full.txt`, disabled the same way
(`RestServerConfig.ax: false`). The path deliberately mirrors the on-disk
layout harnesses consume (`.claude/skills/<name>/SKILL.md`), so
`curl --create-dirs -o .claude/skills/<name>/SKILL.md <baseUrl>/skills/<name>/SKILL.md`
is the entire install step. It also reserves a namespace: multiple skills
per app, or sibling `references/` files, become additive URL changes rather
than breaking ones. `GET /skills/` returns a one-line-per-skill markdown
index (just the one entry in v1). A live skill endpoint means a harness (or
a human) can fetch the current skill for a running service without a
publish step; the committed-file flow above stays available for
offline/registry distribution.

### Recipe contributions: `SKILL_SECTION_TAG`

A second binding tag, mirroring the existing one:

```ts
export const SKILL_SECTION_TAG = 'ax.skill.section'; // AxSection values
```

- Existing `AX_SECTION_TAG` sections (e.g. the MCP surface from
  `installMcpHttp`) appear in the skill too — they describe the contract and
  belong in every artifact.
- `SKILL_SECTION_TAG` sections appear **only** in the skill. This is where
  app authors put workflows, sequencing, rate-limit guidance — prose that
  would be noise in `/llms.txt` but is the entire value-add of a skill.
- Components can contribute both. Example: a future `@agentback/drizzle`
  recipe section, or `mcp-http` contributing "connect over Streamable HTTP
  before listing tools".

### Budget guardrail

Reuse the L-3 heuristic (~4 chars/token, the same constant as
`packages/mcp/src/tool-cost.ts` — hoist the tiny `estimateTokens()` into
`@agentback/common` rather than duplicating it). `generateSkill`
returns normally, but `mountAxRoutes` logs a warning via
`loggers('loopback:rest:ax')` when a rendered skill exceeds a threshold
(default 2 000 tokens, configurable), naming the largest sections. Same
philosophy as flagging bloated tools: measure the context cost, tell the
author, don't silently truncate.

### What the trigger description must do

The frontmatter `description` is the only part of the skill a harness reads
before deciding to load it. The synthesized default must therefore name
**what the API does** and **when to reach for it**, not restate the title.
`info.description`'s first line is the seed; apps with a one-word
description should override `trigger:`. The generated docstring and the
README recipe both say this explicitly — it is the one field where "derived"
can be worse than "authored".

## Testing

- Unit (`packages/rest`): frontmatter shape (valid YAML, kebab-case name,
  description ≤ 1024 chars per the skill spec); compact body contains the
  endpoint index but **not** inlined JSON Schemas; recipes render after
  contract sections; Reference block points at the configured spec paths.
- Integration (extend `agent-contract.integration.ts`):
  `GET /skills/<name>/SKILL.md` returns 200 text/markdown and `GET /skills/`
  lists it; unknown `<name>` returns the standard 404 envelope;
  `SKILL_SECTION_TAG` binding appears in the skill but not `/llms.txt`;
  `ax: false` disables the routes.
- Example: `hello-hybrid` gains a `SKILL_SECTION_TAG` recipe binding and a
  README line showing the fetch.

## Out of scope (v1)

- **Per-tool or per-route skills.** One skill per app matches how MCP
  servers ship skills; finer granularity is speculative until usage data
  exists.
- **Skill directories** (`SKILL.md` + `references/` + `scripts/`). The
  Reference section pointing at live endpoints covers progressive disclosure
  without inventing a packaging/export pipeline; the `/skills/<name>/` URL
  namespace already reserves room for sibling files if consumers later ask
  for offline bundles.
- **Registry/marketplace publishing.** Distribution mechanics
  (skill registries, plugin manifests) move faster than this framework
  should chase; emit the artifact, let the ecosystem carry it.
- **Auto-generated recipes.** No LLM-in-the-loop summarization of routes
  into workflows; the procedural layer stays human-authored by design.
