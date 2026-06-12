# Guide: Composition & extensibility

This is the guide that makes the "modular, extensible, composable" promise
concrete. The framework gives you five tools, ordered here from "reach for
first" to "deepest hook." Pick the lightest one that does the job.

| Tool                                                       | Scope                     | Use for                                   |
| ---------------------------------------------------------- | ------------------------- | ----------------------------------------- |
| [Components](#1-components--package-a-feature)              | a bundle of bindings      | shipping/reusing a whole feature          |
| [Interceptors](#2-interceptors--wrap-method-calls)          | around method invocations | logging, caching, timing, tx, retries     |
| [Middleware](#3-middleware--around-http-requests)           | around HTTP requests      | CORS, rate limit, probes, request tracing |
| [Extension points](#4-extension-points--open-a-plugin-slot) | a registry others fill    | "any number of X" plugin surfaces         |
| [Subclassing dispatch](#subclassing-the-dispatcher)        | the REST pipeline itself  | response envelopes, custom error shapes   |

Underneath all of them is the same principle: **add a binding, don't edit the
core.** ([Why](../concepts/dependency-injection.md#why-this-matters-for-composition).)

## 1. Components — package a feature

A [`Component`](../concepts/components-servers-lifecycle.md#component--a-bundle-of-bindings)
is the unit of reuse: a class that contributes controllers, services,
providers, servers, and lifecycle observers in one registration. Turn any
feature into a component and "adding it" becomes one line.

```ts
import {Component} from '@agentback/core';

export class AuditComponent implements Component {
  controllers = [AuditController];
  classes = {'services.AuditLog': AuditLog};
  lifeCycleObservers = [AuditFlusher];
}

app.component(AuditComponent); // everything above is now in the container
```

The framework's own auth, health, metrics, and MCP support all ship this way —
your features should too. A new feature is a new component, never a diff through
`main()`.

## 2. Interceptors — wrap method calls

An interceptor runs around a method invocation (proceed → or short-circuit). Use
it for behavior that's about _the call_, not _the HTTP request_: timing,
caching, transactions, retries, structured logging.

```ts
import {intercept, Interceptor} from '@agentback/context';

const timed: Interceptor = async (ctx, next) => {
  const start = Date.now();
  try {
    return await next(); // proceed to the method (or the next interceptor)
  } finally {
    console.log(`${ctx.targetName} took ${Date.now() - start}ms`);
  }
};

class ReportController {
  @intercept(timed)
  @get('/report', {response: Report})
  async report() {
    /* … */
  }
}
```

`@globalInterceptor('group')` registers one that applies to **every** invocation
through the container — apply cross-cutting concerns without touching each
method. Interceptors compose in a defined order and work for any DI-invoked
method, not just REST.

## 3. Middleware — around HTTP requests

Middleware sits in front of route handlers, with the real Express
`request`/`response`. Use it for things that are genuinely about the HTTP
request: CORS, rate limiting, health probes, request-id/tracing, body size
limits. `RestApplication` mixes in the middleware machinery.

```ts
// framework-style middleware (gets a MiddlewareContext)
app.middleware(async (ctx, next) => {
  ctx.response.setHeader('x-request-id', crypto.randomUUID());
  return next();
});

// or mount any Express middleware factory
app.expressMiddleware(rateLimit, {windowMs: 60_000, max: 100});
```

The chain runs before route handlers, so middleware can short-circuit (return a
response) for preflights, throttling, or liveness checks.

**CORS** is built in — you don't need middleware for it:

```ts
app.configure('servers.RestServer').to({cors: true}); // sensible defaults
// or {cors: {origin: ['https://app.example.com'], credentials: true}}
// — any CorsOptions from the `cors` package
```

### Interceptor vs middleware — which?

- Touching `req`/`res`, status, headers, or short-circuiting an HTTP request →
  **middleware**.
- Wrapping a method's _invocation_ regardless of transport (also runs for MCP
  tools, internal calls) → **interceptor**.

## 4. Extension points — open a plugin slot

When you want "any number of X, contributed by anyone," define an **extension
point** and let extensions register by tag. This is how the auth stack collects
strategies and how health collects checks.

```ts
import {extensionPoint, extensions} from '@agentback/core';
import {Getter} from '@agentback/context';

@extensionPoint('greeters') // an extension point named "greeters"
class GreetingService {
  constructor(
    @extensions() private getGreeters: Getter<Greeter[]>, // all registered greeters
  ) {}
  async greet(lang: string, name: string) {
    const greeters = await this.getGreeters();
    return greeters.find(g => g.language === lang)?.greet(name);
  }
}

// elsewhere — register an extension for the point:
import {extensionFor} from '@agentback/core';
app.bind('greeters.fr').toClass(FrenchGreeter).apply(extensionFor('greeters'));
```

The service never imports the extensions; it discovers them through the
container. New languages are new bindings — the registry grows without editing
`GreetingService`. (`@inject.tag(tag)` is the lower-level form: inject an array
of everything carrying a tag.)

## Inspect the container

Two UIs help you _see_ the composition you've built:

- **Context Explorer** — browse every binding (key, scope, type, tags,
  injections) and a dependency graph of what injects what. Mount it:

  ```ts
  import {installContextExplorer} from '@agentback/context-explorer';
  await installContextExplorer(app); // -> /context-explorer/
  ```

  Useful when "who provides this?" or "what depends on `services.Clock`?" needs
  an answer. See its [README](../../packages/context-explorer/README.md).

- **MCP Inspector** (`/mcp-inspector`) and **Swagger UI** (`/explorer`) show the
  tool and HTTP surfaces your bindings produce.

## Subclassing the dispatcher

The REST request pipeline is a single, fixed method — there are no LB4
sequences/actions to assemble. For envelope wrappers, custom error shapes, or
request-scoped tracing, subclass `RestServer` and override the `protected`
seams, then bind your subclass.

```ts
import {RestServer} from '@agentback/rest';

class EnvelopingRestServer extends RestServer {
  // wrap every successful result in {data, meta}
  protected sendResult(req, res, result, status) {
    super.sendResult(req, res, {data: result, meta: {at: Date.now()}}, status);
  }
  // shape errors your way
  protected sendError(req, res, err) {
    res.status(err.statusCode ?? 500).json({error: {message: err.message}});
  }
}

app.server(EnvelopingRestServer); // bind your subclass under servers.*
```

The overridable seams are `makeHandler`, `dispatch`, `sendResult`, and
`sendError`. This keeps the common path simple while leaving a real escape hatch
for the rare app that needs to reshape it — without forking the framework.

## A composition checklist

When adding a capability, ask in order:

1. Is it a whole feature others might reuse? → **Component**.
2. Is it behavior around a method call (any transport)? → **Interceptor**.
3. Is it about the HTTP request/response? → **Middleware** (or built-in CORS).
4. Is it "many plugins of a kind"? → **Extension point**.
5. Does it reshape the REST pipeline itself? → **Subclass `RestServer`**.

If none fit, it's probably just a new binding — which is the whole point.

## Next

- [Architecture overview](../architecture/overview.md) — see where each of these
  hooks sits in the request flow.
- [Boundary coherence](../agent-ergonomics.md) — the design philosophy behind
  "add a binding, don't edit the core."
