# @agentback/express

> Express integration that connects the DI container to a middleware chain and an HTTP server lifecycle.

Bridges `@agentback/core`'s IoC container with an Express `app` and an `HttpServer`. Its central
contribution is a **topologically-sorted middleware chain** backed by DI: middleware registered via
`app.middleware(fn)` or `app.expressMiddleware(factory)` are tagged with group and ordering constraints,
sorted on every change, and executed in order before route handlers. Per-request `MiddlewareContext`
extends `Context` so middleware and route handlers can inject from the DI container scoped to each
request.

## What it provides

**Servers & applications**

- `ExpressServer` — `Server` implementation; owns the Express app + `HttpServer`; the middleware chain runs at `basePath` before any route handlers
- `ExpressApplication` — `Application` subclass with a pre-bound `ExpressServer`; accessible as `app.expressServer`
- `ExpressServerConfig` — `HttpOptions | HttpsOptions` plus `basePath?` and `settings?`

**Middleware registration**

- `toMiddleware(handler, ...handlers)` — wrap one or more Express handlers as a LoopBack `Middleware`
- `createMiddleware(factory, config?)` — instantiate a factory-style Express middleware and wrap it
- `registerExpressMiddleware(ctx, factory, config?, options?)` — bind a factory middleware into the context, injectable config
- `registerMiddleware(ctx, middleware, options)` — bind a raw middleware or a `Provider<Middleware>` class
- `asMiddleware(options?)` — binding template that tags a middleware with group/chain/ordering metadata
- `createMiddlewareBinding(ProviderClass, options?)` — create a binding for a `Provider<Middleware>` class

**Invocation**

- `invokeMiddleware(middlewareCtx, options?)` — discover and run the middleware chain for a context
- `invokeExpressMiddleware(middlewareCtx, ...handlers)` — run a list of Express handlers outside the chain
- `toExpressMiddleware(ctx)` — produce an Express request handler that runs all DI-registered middleware for `ctx`
- `MiddlewareView` — live `ContextView` that sorts middleware binding keys by group on every DI change

**Context types**

- `MiddlewareContext` — per-request `Context` carrying `request`, `response`, and `responseFinished`
- `HandlerContext` — `{request, response}` interface
- `MiddlewareChain` — sequential interceptor executor used internally
- `ExpressRequestHandler`, `ExpressMiddlewareFactory`, `Middleware`, `InvokeMiddlewareOptions`, `MiddlewareBindingOptions` — public types

**Mixin**

- `MiddlewareMixin(Application)` — adds `app.middleware(fn)` and `app.expressMiddleware(factory)` to any `Application` subclass; used by `RestApplication`

## Usage

```ts
import {ExpressApplication} from '@agentback/express';
import cors from 'cors';

const app = new ExpressApplication({
  express: {host: '127.0.0.1', port: 3000},
});

// Register Express middleware into the DI chain
app.expressServer.middleware(
  app.expressServer.registerExpressMiddleware(
    app.expressServer,
    cors,
    {origin: '*'},
    {group: 'cors'},
  ),
);

await app.start();
console.log(app.expressServer.url); // http://127.0.0.1:3000
await app.stop();
```

For most use cases, consume `@agentback/rest`'s `RestApplication`, which already applies
`MiddlewareMixin` and exposes `app.middleware()` / `app.expressMiddleware()` directly:

```ts
import {RestApplication} from '@agentback/rest';

const app = new RestApplication();
app.expressMiddleware(cors, {origin: 'https://my.app'});
await app.start();
```

## Layering

Depends on: `@agentback/context`, `@agentback/core`, `@agentback/http-server`,
`@agentback/metadata`, `express ^4`, `body-parser`, `http-errors`, `on-finished`, `toposort`.
Sits above `http-server` and below `rest` in the stack — `rest` inherits its middleware chain via
`MiddlewareMixin` and drives `ExpressServer` as its HTTP transport.
