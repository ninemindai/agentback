# @agentback/middleware

> Runtime-neutral middleware chain machinery (Express-free) shared by `@agentback/rest` and the `@agentback/express` host.

The neutral core of the middleware system: group-tagged middleware bindings in the DI
container, a topological sorter that orders them by `upstreamGroups`/`downstreamGroups`
constraints, and a per-request `MiddlewareContext` that extends `Context` so middleware
and route handlers can inject request-scoped values. Express appears **only in type
positions** — the barrel is edge-safe, so an `EdgeRestApplication` / Cloudflare Workers
app can import from it without pulling Express into the bundle or the install tree.

`@agentback/express` layers the concrete Express host on top of this package;
`@agentback/rest` mounts the sorted chain as the first handler in front of every route.

## What it provides

**Chain & context**

- `MiddlewareContext` — per-request `Context` carrying the `request`/`response` pair; look it up with `getMiddlewareContext(request)`
- `MiddlewareChain` — resolves and runs the group-sorted middleware for a context
- `MiddlewareView` — live `ContextView` that re-sorts middleware binding keys whenever the DI container changes
- `invokeMiddleware(middlewareCtx, options?)` — discover and run the chain for a context
- `InvokeMiddlewareProvider` — DI provider backing `invokeMiddleware`

**Registration & binding**

- `toMiddleware(handler, ...handlers)` / `createMiddleware(factory, config?)` — adapt Express-style handlers or factory middleware into `Middleware`
- `registerMiddleware(ctx, middleware, options)` / `registerExpressMiddleware(ctx, factory, config?, options?)` — bind middleware into a context
- `asMiddleware(options?)` / `createMiddlewareBinding(ProviderClass, options?)` — binding templates that tag group/chain/ordering metadata
- `MiddlewareMixin` — adds `app.middleware(fn)` and `app.expressMiddleware(factory)` to an `Application`

**Interceptors**

- `toInterceptor(...)` / `createInterceptor(...)` / `defineInterceptorProvider(...)` — run Express middleware as method interceptors
- `registerExpressMiddlewareInterceptor(...)` / `createMiddlewareInterceptorBinding(...)` — bind interceptor-flavored middleware

**Keys & groups**

- `MiddlewareBindings` — binding keys (`MIDDLEWARE_CONTEXT`, namespaces for chain discovery)
- `MiddlewareGroups` — the well-known ordering groups (`CORS`, `API_SPEC`, `MIDDLEWARE`, `DEFAULT`, …)
- `ExpressService` / `EXPRESS_SERVICE_KEY` — the seam a host implements to expose its Express app to the chain

## Usage

Applications rarely import this package directly — `@agentback/rest` and
`@agentback/express` re-export the pieces you interact with. Register middleware
through the mixin surface:

```ts
app.middleware(async (middlewareCtx, next) => {
  // runs group-sorted, ahead of every route (including install* helpers)
  return next();
});
```

Order is governed by group tags plus `upstreamGroups`/`downstreamGroups` topological
sort, not registration order. See the middleware-chain notes in the root `CLAUDE.md`
and the diagram at
[`docs/architecture/diagrams/middleware-chain.html`](../../docs/architecture/diagrams/middleware-chain.html).
