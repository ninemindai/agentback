# AgentBack documentation

A TypeScript dependency-injection framework with HTTP (REST) and MCP servers
that plug into the **same container** and validate against the **same Zod
schemas**. This is the place to learn the ideas and build with them.

> New here? Read the [root README](../README.md) for the one-page tour and the
> 30-second code feel, then come back for the depth.

## How the framework thinks

Three ideas carry the whole framework. Everything in these docs is an
elaboration of one of them:

1. **Everything is a binding in a context.** The `Application` _is_ a DI
   `Context`. Controllers, MCP tool classes, services, config, and even the
   servers themselves are just bindings the framework discovers by tag. New
   capability = new binding; you never edit a central registry.
2. **Schemas live once, on the decorator.** A route's or tool's Zod schema is
   simultaneously the runtime validator, the `z.infer` TypeScript type, the
   OpenAPI/MCP contract, and the rendered docs. One artifact, many views.
3. **Servers are components.** REST and MCP are interchangeable, composable
   plug-ins over the same container — run either, or both from one process.

If you internalize those three, the API surface mostly writes itself.

## Learning path

Read top-to-bottom the first time; jump around afterwards.

### Blog — _design notes and release stories_

| Entry                                                  | What you'll find                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Blog home](blog/index.html)                           | Short-form posts: boundary coherence, hybrid REST + MCP apps, schema-shared clients, agent-actionable errors, tool-surface budgets, and self-describing APIs. |
| [Architecture map](blog/diagrams/system-boundary.html) | A standalone dark HTML/SVG diagram of the runtime boundary model, with copy/PNG/PDF export controls.                                                          |

### Concepts — _understand the machine_

| Doc                                                                         | What you'll learn                                                                                                                                |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Dependency injection](concepts/dependency-injection.md)                    | `Context`, `Binding`, scopes, `@inject`, providers, tag-based discovery — the foundation everything sits on.                                     |
| [Schema-first decorators](concepts/schema-first-decorators.md)              | How one Zod schema on a decorator becomes validator + type + OpenAPI + MCP contract; the slot-0 input bundle; runtime + compile-time guarantees. |
| [Components, servers & lifecycle](concepts/components-servers-lifecycle.md) | How a `Component` packages bindings, how a `Server` is discovered and started, and the start/stop lifecycle.                                     |

### Guides — _build something_

| Guide                                                                  | Outcome                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Build a REST API](guides/build-a-rest-api.md)                         | A Zod-validated REST service with auto-emitted OpenAPI 3.1 and Swagger UI.                                   |
| [Build an MCP server](guides/build-an-mcp-server.md)                   | Tools, resources, and prompts an MCP client (or Claude) can call, with an inspector UI.                      |
| [Build a hybrid app](guides/build-a-hybrid-app.md)                     | REST + MCP from a single process and a single set of schemas, plus a type-safe HTTP client.                  |
| [Render a widget with MCP Apps](guides/mcp-apps-widgets.md)            | An interactive `ui://` widget a host (Claude Desktop) renders inline for a tool's result (SEP-1865).         |
| [Composition & extensibility](guides/composition-and-extensibility.md) | The modular toolkit: components, middleware, interceptors, extension points, and subclassing the dispatcher. |
| [Testing](guides/testing.md)                                           | `createTestApp` and the four client surfaces: typed calls, supertest, in-memory MCP, DI assertions.          |
| [Secure MCP over HTTP](guides/secure-mcp-over-http.md)                 | Auth modes (strategies vs OAuth 2.1 resource server), scope-gated tools, DNS-rebinding, rate limits.         |
| [Agent console security](guides/agent-console.md)                      | Security model for the ACP agent dock: off by default, loopback-only, auth requirements, permission scoping. |
| [HTTP hosts](guides/deploy-to-edge.md)                                 | Run REST + MCP on Node, Fastify, Hono, Bun, Deno, or Workers from one `fetchHandler()`. The native listener. |
| [Deploy to production](guides/deploy-to-production.md)                 | Containers, validated config, K8s probes, metrics/tracing, graceful shutdown, multi-instance checklist.      |

### Reference & design

| Doc                                                          | Purpose                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [Architecture overview](architecture/overview.md)            | The big picture: how a request flows, how servers discover bindings, full package layering. Diagrams included.                                  |
| [Package catalog](packages.md)                               | Every `@agentback/*` package and `create-agentback`, grouped by layer (DI foundation, REST/MCP/clients, platform).                              |
| [Metering & payments](architecture/metering-and-payments.md) | Counting every REST/MCP call (`metering`) and gating or billing the paid ones — x402 / MPP / Stripe (`payments`). Diagrams.                     |
| [Boundary coherence (design thesis)](agent-ergonomics.md)    | _Why_ the framework is shaped this way — the "one artifact, viewed differently" bet and what it buys AI-led teams.                              |
| [Database story](db-story.md)                                | The framework's stance on persistence (Drizzle recipe), and why there's no built-in ORM.                                                        |
| [Actor model](actor-model.md)                                | The actor model: `@actor` services, per-identity serialized turns, the `ActorRuntime` port, and the Redis adapter. See `examples/hello-actors`. |

Every package under [`packages/`](../packages/) carries its own `README.md` with
its exports, a usage snippet, and where it sits in the layering.

**Server extensions** (`install*` onto a running REST server):
[health/readiness probes](../packages/extension-health/README.md) ·
[Prometheus metrics](../packages/extension-metrics/README.md) ·
[rate limiting](../packages/extension-rate-limit/README.md) (in-memory or Redis,
`429` + `RateLimit-*` headers).

**Metering & payments** (subclass the dispatcher / mount a rail):
[usage metering](../packages/metering/README.md) (per-principal
`UsageEvent`s → audit-log sinks + quota) ·
[payments](../packages/payments/README.md) (x402 / MPP / Stripe) — see the
[architecture doc](architecture/metering-and-payments.md).

## The shortest possible example

```ts
import {z} from 'zod';
import {api, get} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';

@api({basePath: '/greet'})
class GreetingController {
  @get('/hello/{name}', {
    path: z.object({name: z.string().min(1)}),
    response: z.object({greeting: z.string()}),
  })
  async hello(input: {path: {name: string}}) {
    return {greeting: `Hello, ${input.path.name}!`};
  }
}

const app = new RestApplication();
app.restController(GreetingController);
await app.start();
// GET /greet/hello/world  -> {"greeting":"Hello, world!"}
// GET /openapi.json       -> OpenAPI 3.1.1 derived from the Zod schemas
```

Change `GreetingController` to an `@mcpServer()` with `@tool(...)` methods and
the same schemas become an MCP tool surface instead — see
[Build an MCP server](guides/build-an-mcp-server.md).

## Runnable examples

Each guide maps to a working example you can run:

```bash
pnpm install && pnpm build       # build first — tests/examples run against dist/
pnpm -F hello-rest start         # REST + Swagger UI + Context Explorer
pnpm -F hello-mcp test           # MCP over stdio, driven by a test client
pnpm -F hello-hybrid start       # REST + MCP from one process, both UIs
pnpm -F hello-client start       # the typed client calling hello-rest's schemas
```

| Example                   | Demonstrates                               | Guide                                                                     |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| `examples/hello-rest`     | REST + auth + health + metrics + explorers | [REST](guides/build-a-rest-api.md)                                        |
| `examples/hello-mcp`      | MCP tools over stdio                       | [MCP](guides/build-an-mcp-server.md)                                      |
| `examples/hello-hybrid`   | REST + MCP in one process                  | [Hybrid](guides/build-a-hybrid-app.md)                                    |
| `examples/hello-client`   | Schema-shared typed client                 | [Hybrid](guides/build-a-hybrid-app.md#a-type-safe-client-with-no-codegen) |
| `examples/hello-mcp-apps` | MCP Apps `ui://` widget rendered by a host | [MCP Apps](guides/mcp-apps-widgets.md)                                    |
| `examples/hello-actors`         | Addressable, serialized actors over REST                      | [Actor model](actor-model.md)                                             |
| `examples/hello-agent-console`  | Introspection MCP + agent console dock (see + evolve)         | [Agent console security](guides/agent-console.md)                         |

## Conventions in these docs

- Code blocks are real, compiling TypeScript drawn from the packages and
  examples — not pseudocode.
- ESM only: relative imports carry `.js` extensions in actual source; doc
  snippets omit them for readability where the import is from a package.
- "Slot 0 / slot 1+" refers to a handler method's parameter positions — see
  [Schema-first decorators](concepts/schema-first-decorators.md#the-handler-signature).
