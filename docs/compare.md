# Switching to AgentBack

AgentBack isn't a faster router or another MCP library. It's one Zod schema
turned into your REST routes, your OpenAPI 3.1 document, your MCP tools, your
typed client, and your runtime validation — served from a single process with a
real dependency-injection container. If you're arriving from one of the
frameworks below, here's what carries over and what you gain.

| Coming from                            | What carries over                                                                            | What you gain                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [**LoopBack 4**](https://loopback.io/) | DI instincts — `@inject`, `@injectable`, `Context`, binding scopes, extension points map 1:1 | Zod-first schemas, MCP tools, OpenAPI 3.1 emitted from the same Zod, ESM/Node 22, no `@loopback/repository` baggage          |
| [**NestJS**](https://nestjs.com/)      | Decorated classes and a DI container                                                         | One Zod-on-decorator source instead of `nestjs-zod` + `@nestjs/swagger` + a community MCP bridge across two metadata systems |
| [**tRPC**](https://trpc.io/)           | A no-codegen, end-to-end-typed client                                                        | Your API is _also_ a public OpenAPI 3.1 document and MCP tools — first-class outputs, not a bolt-on — plus a DI container    |
| [**ts-rest**](https://ts-rest.com/)    | Contract-first discipline                                                                    | The same contract becomes MCP tools an agent can call, under one `@authorize` policy, plus a DI container                    |
| [**Hono**](https://hono.dev/)          | —                                                                                            | `@hono/zod-openapi` + `@hono/mcp` + hand-written SDK tools collapse to one schema, one process                               |

## One schema, every boundary

The whole pitch in one screen — the same forecast endpoint as a typical
multi-library setup, then as one AgentBack class. On the left the validation
schema, the OpenAPI registration, and the MCP tool are three declarations that
drift apart; on the right they are one.

<!-- prettier-ignore -->
<div class="code-compare">
<figure>
<figcaption>A typical TS stack — schema, OpenAPI, and MCP declared separately</figcaption>
<pre><code>// 1 — the validation schema
const Forecast = z.object({city: z.string(), tempC: z.number()});
// 2 — register it again for OpenAPI (a separate lib)
registry.registerPath({
  method: 'get',
  path: '/forecast/{city}',
  responses: {200: {content: {'application/json': {schema: Forecast}}}},
});
// 3 — declare it a third time as an MCP tool
server.tool('forecast', {city: z.string()}, async ({city}) =&gt; ({
  content: [{type: 'text', text: await lookup(city)}],
}));
// 4 — and the route handler itself
app.get('/forecast/:city', c =&gt; c.json(lookup(c.req.param('city'))));</code></pre>
</figure>
<figure>
<figcaption>AgentBack — one schema on the decorators, one class</figcaption>
<pre><code>const Params = z.object({city: z.string()});
const Forecast = z.object({city: z.string(), tempC: z.number()});
@api()
@mcpServer()
class Weather {
  // one schema → REST validator + OpenAPI 3.1 + response check
  @get('/forecast/{city}', {path: Params, response: Forecast})
  async getForecast(input: {path: z.infer&lt;typeof Params&gt;}) {
    return lookup(input.path.city);
  }
  // …and the same schema → an MCP tool's input/output contract
  @tool('forecast', {input: Params, output: Forecast})
  async forecastTool(input: z.infer&lt;typeof Params&gt;) {
    return lookup(input.city);
  }
}</code></pre>
</figure>
</div>

## From LoopBack 4

AgentBack is an ESM port of LoopBack 4's dependency-injection core, so
`@inject`, `@injectable`, `Context`, binding scopes, and extension points behave
exactly as you remember — and the `@authenticate` / `@authorize` stack is ported
too. If you know LB4 DI, you already know this half of the framework.

What changes is everything above the container. Schemas are Zod instead of the
`@loopback/repository-json-schema` pipeline, and that schema lives on the route
decorator — there's no `@param` / `@requestBody` / `@response`; the handler's
input is `z.infer` of the schema you declared. The same Zod emits OpenAPI 3.1
and, with `@tool`, an MCP tool contract. Upstream's ~10k-line sequence/action
pipeline (`findRoute → parseParams → invoke → send → reject`) becomes one fixed
dispatch you tune on decorators or by subclassing, and `@loopback/repository`
with its `Filter` / `Where` helpers is intentionally gone — bring your own data
layer (Drizzle is the blessed recipe). You keep the architecture and the DI
muscle memory, and gain an MCP surface, a no-codegen typed client, and ESM /
Node 22.

## From NestJS

Keep the mental model you like — decorated classes and constructor injection —
but collapse the metadata sprawl. A typical Nest endpoint carries a DTO with
`class-validator` decorators, a separate `@nestjs/swagger` decorator for the
OpenAPI shape, and — to reach agents — a third tool definition through a
community bridge like MCP-Nest: three declarations across two metadata systems
that can fall out of sync.

AgentBack replaces all of that with one `z.object()` on the decorator. It is the
validator, the TypeScript type (via `z.infer`), the OpenAPI 3.1 schema, and the
MCP `inputSchema` at once. `@injectable` / `@inject` and a `Context` container
stand in for `@Injectable` / providers, so the wiring feels familiar — and a
single `@authorize` policy governs both the HTTP route and the MCP tool's
visibility and dispatch, instead of a route guard plus a separate agent layer.
One source of truth instead of four.

## From tRPC

Your no-codegen, end-to-end-typed client carries straight over: AgentBack's
client imports the very same Zod schemas the server validates against —
`safeCall`, typed `responses[status]`, no generation step and no router-type
import gymnastics.

The difference is reach. tRPC is RPC-first and its types live inside your
TypeScript monorepo, so a public API or a non-TS consumer needs `trpc-openapi`,
a separate and lossy layer; AgentBack's routes are real REST with a first-class
OpenAPI 3.1 document at `/openapi.json`. tRPC also has no DI container — auth
rides on `context` and middleware — where AgentBack gives you one for services,
auth, and multi-tenancy. And where tRPC and oRPC lean toward Vercel AI SDK
tools, AgentBack emits MCP tools from the same procedures, under the same
`@authorize` policy that guards the HTTP side.

## From ts-rest

The contract-first discipline is the same idea: define the shape once, share it
across client and server. The difference is where the contract lives. In ts-rest
it's a standalone contract object you define and then implement separately — two
artifacts to keep aligned. In AgentBack the Zod schema on the decorator _is_ the
contract: the handler's slot-0 input is `z.infer` of it, checked at compile
time, so there's no second declaration to drift.

That same schema also emits an OpenAPI 3.1 document and becomes MCP tools an
agent can call, governed by the `@authorize` policy that guards your HTTP routes.
And you get a real DI container to wire services and auth, which ts-rest leaves
to you.

## From Hono

To reach REST + OpenAPI 3.1 + MCP + a typed client on Hono you assemble several
libraries — `@hono/zod-openapi`, `@hono/mcp`, and hand-written SDK tools — each
with its own schema declaration to keep aligned. In AgentBack a single
controller class delivers all of it from one schema: routing, Zod validation,
the OpenAPI document, the MCP tools, and the schema-shared client, in one
process.

The trade-off is honest. Hono is a minimal, functional, edge-first router;
AgentBack is a decorator- and DI-based framework built around classes — though
an `EdgeRestApplication` host runs the same app on fetch / Workers / Bun / Deno
when you need it. If raw routing speed is your priority, Hono belongs on your
list — AgentBack's pitch is consolidation, not benchmarks.

## Get started

Whatever you're coming from, the first step is the same:

`npm create agentback`
