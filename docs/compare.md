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

Each section below shows the same forecast endpoint — a REST route _and_ an
agent-callable tool — first in that framework, then in AgentBack. The AgentBack
class is identical every time; it's spelled out in full under **From LoopBack
4** and abbreviated after that.

## From LoopBack 4

The DI core is identical; what changes is the schema layer. LB4's `@model` /
`@property` + `getModelSchemaRef` become one Zod object on the decorator — which
also defines an MCP tool, something LB4 has no answer for.

<!-- prettier-ignore -->
<div class="code-compare">
<figure>
<figcaption>LoopBack 4</figcaption>
<pre><code>// model + JSON-schema decorators
@model()
class Forecast {
  @property() city: string;
  @property() tempC: number;
}
class WeatherController {
  @get('/forecast/{city}')
  @response(200, {content: {'application/json':
    {schema: getModelSchemaRef(Forecast)}}})
  forecast(@param.path.string('city') city: string) {
    return lookup(city);
  }
}
// MCP is not built in.</code></pre>
</figure>
<figure>
<figcaption>AgentBack</figcaption>
<pre><code>const City = z.object({city: z.string()});
const Out = z.object({tempC: z.number()});
@api() @mcpServer()
class Weather {
  @get('/forecast/{city}', {path: City, response: Out})
  route(i: {path: {city: string}}) {
    return lookup(i.path.city);
  }
  @tool('forecast', {input: City, output: Out})
  tool(i: {city: string}) {
    return lookup(i.city);
  }
}</code></pre>
</figure>
</div>

## From NestJS

Decorated classes and constructor injection carry over. The `class-validator`
DTO, the `@nestjs/swagger` decorator, and a community MCP-Nest tool — three
declarations across two metadata systems — collapse into one Zod object.

<!-- prettier-ignore -->
<div class="code-compare">
<figure>
<figcaption>NestJS</figcaption>
<pre><code>// DTO: class-validator + swagger
class ForecastDto {
  @ApiProperty() @IsString() city: string;
  @ApiProperty() @IsNumber() tempC: number;
}
@Controller()
class WeatherController {
  @Get('forecast/:city')
  @ApiOkResponse({type: ForecastDto})
  forecast(@Param('city') city: string) {
    return lookup(city);
  }
}
// + a separate MCP-Nest @Tool method</code></pre>
</figure>
<figure>
<figcaption>AgentBack — same class</figcaption>
<pre><code>// the Weather class from the LoopBack section:
// one Zod schema → a @get route and a @tool
@api() @mcpServer()
class Weather {
  @get('/forecast/{city}', {path: City, response: Out})
  route(i) { ... }
  @tool('forecast', {input: City, output: Out})
  tool(i) { ... }
}</code></pre>
</figure>
</div>

## From tRPC

The typed client is what carries over. In tRPC the contract is the exported
router _type_ (TypeScript-only); in AgentBack it's the Zod schema — so the same
procedure is also real REST, an OpenAPI 3.1 document, and an MCP tool.

<!-- prettier-ignore -->
<div class="code-compare">
<figure>
<figcaption>tRPC</figcaption>
<pre><code>// RPC router + zod input
const appRouter = router({
  forecast: publicProcedure
    .input(z.object({city: z.string()}))
    .query(({input}) =&gt; lookup(input.city)),
});
export type AppRouter = typeof appRouter;
// typed client call
trpc.forecast.query({city: 'sf'});
// REST / OpenAPI / MCP: add-ons only</code></pre>
</figure>
<figure>
<figcaption>AgentBack — same class</figcaption>
<pre><code>// the Weather class from the LoopBack section:
// one Zod schema → a @get route and a @tool
@api() @mcpServer()
class Weather {
  @get('/forecast/{city}', {path: City, response: Out})
  route(i) { ... }
  @tool('forecast', {input: City, output: Out})
  tool(i) { ... }
}</code></pre>
</figure>
</div>

## From ts-rest

Contract-first carries over. ts-rest keeps the contract as a standalone object
you implement separately — two artifacts to align. In AgentBack the decorator's
Zod schema _is_ the contract, and it also yields MCP tools and OpenAPI.

<!-- prettier-ignore -->
<div class="code-compare">
<figure>
<figcaption>ts-rest</figcaption>
<pre><code>// 1. contract — a separate artifact
const contract = c.router({
  forecast: {
    method: 'GET',
    path: '/forecast/:city',
    responses: {200: z.object({tempC: z.number()})},
  },
});
// 2. implement it separately
const router = s.router(contract, {
  forecast: async ({params}) =&gt;
    ({status: 200, body: await lookup(params.city)}),
});</code></pre>
</figure>
<figure>
<figcaption>AgentBack — same class</figcaption>
<pre><code>// the Weather class from the LoopBack section:
// one Zod schema → a @get route and a @tool
@api() @mcpServer()
class Weather {
  @get('/forecast/{city}', {path: City, response: Out})
  route(i) { ... }
  @tool('forecast', {input: City, output: Out})
  tool(i) { ... }
}</code></pre>
</figure>
</div>

## From Hono

Hono reaches this with `@hono/zod-openapi` + `@hono/mcp` + hand-written SDK
tools, each with its own schema to keep aligned. AgentBack does routing,
validation, OpenAPI, and MCP from one class. (Hono is an excellent edge router;
if raw routing speed is your priority it belongs on your list — the pitch here
is consolidation, not benchmarks.)

<!-- prettier-ignore -->
<div class="code-compare">
<figure>
<figcaption>Hono</figcaption>
<pre><code>// @hono/zod-openapi route
const route = createRoute({
  method: 'get', path: '/forecast/{city}',
  responses: {200: {content: {'application/json':
    {schema: Out}}}},
});
app.openapi(route, c =&gt;
  c.json(lookup(c.req.param('city'))));
// separate MCP SDK tool, mounted via @hono/mcp
mcp.registerTool('forecast',
  {inputSchema: z.object({city: z.string()})}, handler);</code></pre>
</figure>
<figure>
<figcaption>AgentBack — same class</figcaption>
<pre><code>// the Weather class from the LoopBack section:
// one Zod schema → a @get route and a @tool
@api() @mcpServer()
class Weather {
  @get('/forecast/{city}', {path: City, response: Out})
  route(i) { ... }
  @tool('forecast', {input: City, output: Out})
  tool(i) { ... }
}</code></pre>
</figure>
</div>

## Get started

Whatever you're coming from, the first step is the same:

`npm create agentback`
