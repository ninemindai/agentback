# MCP Tool Servers

## Table of Contents

- [Overview](#overview)
- [Defining an MCP Server Class](#defining-an-mcp-server-class)
- [The `@tool` Decorator](#the-tool-decorator)
- [Resources and Prompts](#resources-and-prompts)
- [Transport: stdio (MCPApplication)](#transport-stdio-mcpapplication)
- [Transport: HTTP (installMcpHttp)](#transport-http-installmcphttp)
- [Scope-Gated Tools](#scope-gated-tools)
- [Auth and Rate Limiting over HTTP](#auth-and-rate-limiting-over-http)
- [Tool Dispatch Flow](#tool-dispatch-flow)
- [In-Process Inspector](#in-process-inspector)
- [Key Rules](#key-rules)

## Overview

`@agentback/mcp` provides decorator-driven MCP servers. Define a plain
class, annotate it with `@mcpServer()`, declare tools/resources/prompts with
method decorators, and hand the class to the DI container. `MCPServer` discovers
every tagged class at startup, registers its surface with the official
`@modelcontextprotocol/sdk`, and connects a transport.

The two layers are independent: REST and MCP share the same `Application` and DI
container but have no runtime dependency on each other. Both use the same
`@inject` mechanism for constructor and parameter injection.

```bash
pnpm add @agentback/mcp zod
# HTTP transport (optional):
pnpm add @agentback/mcp-http
# In-process inspector UI (optional):
pnpm add @agentback/mcp-inspector
```

## Defining an MCP Server Class

`@mcpServer()` is built on `@injectable`: it marks the class as an _extension_ of
the `MCP_SERVERS` extension point (`extensionFor: MCP_SERVERS`) and defaults it to
singleton scope, so `MCPServer` finds it via `extensionFilter(MCP_SERVERS)` at
startup. Pass options to customize — `@mcpServer({scope, tags})` or
`@mcpServer('name')`. Never call `.tag()` manually — the decorator does it.

```ts
import {z} from 'zod';
import {inject} from '@agentback/core';
import {mcpServer, tool} from '@agentback/mcp';

const ForecastInput = z.object({city: z.string().min(1)});
const ForecastOutput = z.object({forecast: z.string(), unit: z.string()});

@mcpServer()
class WeatherTools {
  constructor(@inject('services.weather') private weather: WeatherService) {}

  @tool('get_forecast', {
    input: ForecastInput,
    output: ForecastOutput,
    description: 'Current weather for a city',
  })
  async getForecast(input: z.infer<typeof ForecastInput>) {
    return this.weather.forecast(input.city);
  }
}
```

Register it with **`app.service(WeatherTools)`** — a tool is a DI service. The
MCP server discovers it as an `MCP_SERVERS` extension and resolves the instance
through its binding (`MCPServer.resolveMember`), so constructor `@inject` is
honored regardless of namespace — `service`, `controller`, or a manual
`bind().apply(extensionFor(MCP_SERVERS))` all work.

**Dual REST + MCP class** (one class carrying both `@api` and `@mcpServer`):
register it with **both** `app.restController(C)` _and_ `app.service(C)`.
`restController` serves the REST routes; `service` registers it as the MCP
extension. `restController` tags it for REST only, so drop `service` and the MCP
surface goes dark.

## The `@tool` Decorator

```ts
@tool(name, options?)
```

`options` fields:

| field         | type        | required | meaning                                           |
| ------------- | ----------- | -------- | ------------------------------------------------- |
| `input`       | `ZodObject` | no       | Zod schema for slot 0; drives the SDK inputSchema |
| `output`      | `ZodObject` | no       | Zod schema for the return; validated at runtime   |
| `description` | `string`    | no       | Shown in tools/list                               |
| `title`       | `string`    | no       | Human-readable display name                       |
| `scope`       | `string`    | no       | OAuth scope required to see/call the tool         |

### Slot 0 = `z.infer<typeof input>` when input is declared

When `input` is set, **slot 0 of the method receives the Zod-validated input
bundle**. `@inject(...)` parameters must go at slot 1+. Putting `@inject` at slot
0 alongside an `input` throws at decoration time with the class, method, and
decorator named.

```ts
@tool('get_forecast', {input: ForecastInput, output: ForecastOutput})
async getForecast(
  input: z.infer<typeof ForecastInput>,            // slot 0 — validated input
  @inject(MCPBindings.REQUEST_AUTH, {optional: true}) auth?: AuthInfo, // slot 1 — injected
) { … }
```

### No-input tools are valid

When `input` is omitted, all slots are unconstrained and typically carry
`@inject` parameters.

```ts
@tool('ping')
async ping(): Promise<{ok: boolean}> {
  return {ok: true};
}

@tool('whoami')
async whoami(
  @inject('services.identity') id: IdentityService,
) {
  return id.current();
}
```

### Output validation

When `output` is declared, the return type is constrained at compile time via
`TypedPropertyDescriptor` and validated at invocation time via `output.safeParse`.
A mismatch throws (unlike REST, which only logs). The SDK additionally surfaces
`structuredContent` alongside the text frame for clients that consume typed
payloads.

## Resources and Prompts

`@resource` and `@prompt` follow the same class-decoration pattern.

```ts
import {resource, prompt} from '@agentback/mcp';

@mcpServer()
class WeatherTools {
  // @resource wraps the return in {contents:[{uri, mimeType, text}]}
  @resource('climate_zones', 'weather://climate-zones', {
    description: 'Static climate zone reference',
    mimeType: 'application/json',
  })
  async climateZones() {
    return [{zone: 'tropical', lat: '0-23.5°'}];
  }

  // @prompt wraps the return in {messages:[{role:'user', content:{type:'text', text}}]}
  @prompt('forecast_prompt', {
    description: 'Prompt template for weather queries',
  })
  async forecastPrompt() {
    return 'Describe the weather in {city} in plain English.';
  }
}
```

Resources and prompts have no Zod validation on their return values; the
framework JSON-serializes any non-string result.

## Transport: stdio (MCPApplication)

`MCPApplication` is an `Application` subclass with `MCPComponent` pre-mounted.
Use it for stdio-only servers. After `app.start()` the process communicates over
stdin/stdout using JSON-RPC; **any `console.log` or other stdout write corrupts
the protocol** — log to `stderr` instead.

```ts
import {MCPApplication, mcpServer, tool} from '@agentback/mcp';

const EchoInput = z.object({text: z.string().min(1).max(280)});

@mcpServer()
class EchoTools {
  @tool('echo', {input: EchoInput, description: 'Echoes back the text.'})
  async echo(input: z.infer<typeof EchoInput>) {
    return {echoed: input.text, at: new Date().toISOString()};
  }
}

const app = new MCPApplication();
app.configure('servers.MCPServer').to({name: 'my-server', version: '1.0.0'});
app.service(EchoTools);
await app.start(); // blocks until stdin closes
process.stderr.write('stdio transport ready\n'); // stderr only
```

For a hybrid REST + stdio server, mount `MCPComponent` on a `RestApplication`
instead of using `MCPApplication`.

## Transport: HTTP (installMcpHttp)

`@agentback/mcp-http` exposes the same tool surface over the MCP
**Streamable HTTP** transport. Each client session gets its own underlying SDK
server (`buildServer({scopes})`), connected to a
`StreamableHTTPServerTransport`, keyed by `Mcp-Session-Id`. This is required
because a single `McpServer` can only be connected to one live transport at a
time.

Endpoints mounted at `/mcp` (configurable via `path`):

| method   | meaning                                              |
| -------- | ---------------------------------------------------- |
| `POST`   | client → server JSON-RPC (initialize, tools/call, …) |
| `GET`    | SSE stream for server → client messages              |
| `DELETE` | terminate a session                                  |

```ts
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {installMcpHttp} from '@agentback/mcp-http';

const app = new RestApplication();
app.configure('servers.MCPServer').to({name: 'my-server', version: '1.0.0'});
app.component(MCPComponent);
app.service(MyTools);

await installMcpHttp(app); // call before app.start()
await app.start();
```

`installMcpHttp` throws if no MCP server is bound — add `MCPComponent` first.
For a non-`RestApplication` Express app use `mountMcpHttp(mcpServer, expressApp, opts)`.

### Resumable sessions

Pass `eventStore` to replay missed events when a dropped SSE stream reconnects
with `Last-Event-ID`. The bundled `InMemoryEventStore` suits a single process;
implement `EventStore` over Redis for multi-instance.

```ts
import {installMcpHttp, InMemoryEventStore} from '@agentback/mcp-http';
await installMcpHttp(app, {eventStore: new InMemoryEventStore()});
```

### DNS rebinding protection

A browser-reachable MCP endpoint is a DNS-rebinding target. Pin the
`allowedHosts` / `allowedOrigins` allowlists in production; setting either
automatically enables the protection check.

```ts
await installMcpHttp(app, {
  allowedHosts: ['mcp.example.com'],
  allowedOrigins: ['https://app.example.com'],
});
```

## Scope-Gated Tools

Tag a tool with `scope` to restrict which sessions see and can call it. A
session's server is built with `buildServer({scopes: callerScopes})`, which only
registers tools whose `scope` the caller holds. Tools without a `scope` are
always registered. The gating is **by construction** — both `tools/list` and
`tools/call` are filtered; there is no separate ACL check at call time.

```ts
@tool('admin_ping', {
  description: 'Admin-only tool.',
  scope: 'admin',
})
async adminPing(): Promise<{ok: boolean}> {
  return {ok: true};
}
```

Scope gating is active only when `auth` or `strategyAuth` is configured on
`installMcpHttp`. On unauthenticated transports (stdio, or HTTP without auth)
`buildServer()` receives no scopes and every tool is registered.

## Auth and Rate Limiting over HTTP

### SDK OAuth (resource server)

Pass `auth` to protect `/mcp` as an OAuth 2.1 resource server. Every request
must carry a valid `Authorization: Bearer <token>`. Supply a `verifier` that
validates tokens against your authorization server's JWKS.

```ts
await installMcpHttp(app, {
  auth: {
    verifier: {
      async verifyAccessToken(token) {
        const claims = await verifyJwtAgainstJwks(token); // your impl
        return {
          token,
          clientId: claims.azp,
          scopes: (claims.scope ?? '').split(' '),
          expiresAt: claims.exp,
        };
      },
    },
    resource: 'https://api.example.com/mcp',
    authorizationServers: ['https://auth.example.com'],
    scopesSupported: ['mcp:tools', 'admin'],
  },
});
```

### Framework-strategy auth (`strategyAuth`)

Authenticate `/mcp` with the same `@agentback/authentication` strategies
used on REST routes — `jwt`, `api-key`, `client-credentials`, `anonymous`, or a
custom strategy. The authenticated principal's scopes drive the per-session tool
ACL, and the principal is bound to `MCPBindings.REQUEST_AUTH` for injection into
tool handlers.

```ts
import {
  ApiKeyAuthenticationStrategy,
  API_KEY_VERIFIER,
  AuthenticationBindings,
} from '@agentback/authentication';
import {securityId} from '@agentback/security';

// Wire up the api-key strategy
app.bind(API_KEY_VERIFIER).to((key: string) => {
  const principals: Record<string, {scopes: string[]}> = {
    'admin-key': {[securityId]: 'admin', scopes: ['admin', 'mcp:tools']},
    'user-key': {[securityId]: 'user', scopes: ['mcp:tools']},
  };
  return principals[key]; // undefined → 401
});
app
  .bind('strategies.apiKey')
  .toClass(ApiKeyAuthenticationStrategy)
  .tag(AuthenticationBindings.AUTH_STRATEGY);

await installMcpHttp(app, {
  strategyAuth: {strategy: ['api-key', 'jwt']}, // tried in order; 401 if none pass
  rateLimit: {
    points: 60, // 60 calls per tool per caller per minute (default)
    durationSecs: 60,
    perTool: {
      expensive_report: {points: 5, durationSecs: 60}, // tighter for one tool
    },
  },
});
```

Set `strategyAuth.required: false` for optional auth (anonymous sessions receive
an unscoped tool set). Override the scope derivation via
`strategyAuth.scopes(auth)`.

### Injecting the caller identity

A `@tool` handler can receive the caller's auth info at any slot after 0:

```ts
@tool('get_forecast', {input: ForecastInput})
async getForecast(
  input: z.infer<typeof ForecastInput>,
  @inject(MCPBindings.REQUEST_AUTH, {optional: true}) auth?: AuthInfo,
) {
  console.log('caller clientId:', auth?.clientId);
  return this.weather.forecast(input.city);
}
```

`MCPBindings.REQUEST_AUTH` is `undefined` on stdio / unauthenticated calls, so
always mark it `{optional: true}`.

### Per-tool rate limiting

`rateLimit` throttles `tools/call` with a separate bucket per **(caller, tool)**,
keyed by `clientId` from `auth`/`strategyAuth` or by client IP. Non-tool methods
(`initialize`, `tools/list`) are never rate-limited. On exceed the server returns
`429` with a JSON-RPC error and `Retry-After`.

Pass a `store` (ioredis-compatible) to share buckets across instances; omitting
it uses in-memory storage. Store failures fail open.

## Tool Dispatch Flow

For each `tools/call` the SDK delivers to `MCPServer`:

1. **Parse input** — `input.safeParse(rawInput)` if an `input` schema is
   declared; throws with Zod issue details on failure.
2. **Build per-request context** — when `authInfo` is present on the SDK `extra`
   object, a child `Context` is created and `MCPBindings.REQUEST_AUTH` is bound
   into it.
3. **Weave `@inject` arguments** — `resolveInjectedArguments` resolves slots 1+
   against the (possibly per-request) context; the parsed input occupies slot 0.
4. **Invoke the method** — `instance[methodName].apply(instance, args)`.
5. **Validate output** — `output.safeParse(result)` if an `output` schema is
   declared; throws on mismatch.
6. **Serialize** — non-string results are `JSON.stringify`-ed into a `{type:
'text', text}` content frame. When `output` is declared, the raw object is
   also surfaced as `structuredContent` for clients that consume typed payloads.

## In-Process Inspector

`@agentback/mcp-inspector` mounts a React SPA at `/mcp-inspector` that
lists tools, resources, and prompts and lets you invoke them without going
through an MCP transport.

```ts
import {installInspector} from '@agentback/mcp-inspector';

await installInspector(app); // before app.start()
await app.start();
// UI at http://host:port/mcp-inspector/
```

`installInspector` throws if `MCPComponent` has not been mounted. The inspector
calls `MCPServer.callTool` / `readResource` / `getPrompt` directly, so it
exercises the same Zod validation + DI dispatch path as the real transport. The
`/mcp-inspector/api` endpoints (`GET /manifest`, `POST /tools/{name}/call`, etc.)
are declared via `@api`-decorated REST controllers registered in the DI container.

## Key Rules

- `@mcpServer()` is built on `@injectable` — tags the class `extensionFor: MCP_SERVERS` (singleton by default). Never tag manually.
- **Slot 0 = `z.infer<typeof input>`** when `input` is declared; `@inject` at
  slot 1+. Violation throws at decoration time.
- **No `input`** → tool takes no validated input; all slots free for `@inject`.
- **`output` validation throws** on mismatch (unlike REST, which logs).
- **Stdio stdout is the transport wire** — all logging after `app.start()` must
  go to `stderr`.
- **HTTP transport = per-session servers** built by `buildServer({scopes})`;
  scope gating is by construction (both list and call).
- `MCPBindings.REQUEST_AUTH` is `undefined` on stdio / unauthenticated calls —
  always inject `{optional: true}`.
- `installMcpHttp` must be called before `app.start()`.
- `pnpm build` is required before tests; tests run against `dist/`, not `src/`.
