# Switching to AgentBack

AgentBack isn't a faster router or another MCP library. It's one Zod schema
turned into your REST routes, your OpenAPI 3.1 document, your MCP tools, your
typed client, and your runtime validation — served from a single process with a
real dependency-injection container. If you're arriving from one of the
frameworks below, here's what carries over and what you gain.

| Coming from    | What carries over                                                                            | What you gain                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **LoopBack 4** | DI instincts — `@inject`, `@injectable`, `Context`, binding scopes, extension points map 1:1 | Zod-first schemas, MCP tools, OpenAPI 3.1 emitted from the same Zod, ESM/Node 22, no `@loopback/repository` baggage          |
| **NestJS**     | Decorated classes and a DI container                                                         | One Zod-on-decorator source instead of `nestjs-zod` + `@nestjs/swagger` + a community MCP bridge across two metadata systems |
| **tRPC**       | A no-codegen, end-to-end-typed client                                                        | Your API is _also_ a public OpenAPI 3.1 document and MCP tools — first-class outputs, not a bolt-on — plus a DI container    |
| **ts-rest**    | Contract-first discipline                                                                    | The same contract becomes MCP tools an agent can call, under one `@authorize` policy, plus a DI container                    |
| **Hono**       | —                                                                                            | `@hono/zod-openapi` + `@hono/mcp` + hand-written SDK tools collapse to one schema, one process                               |

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
