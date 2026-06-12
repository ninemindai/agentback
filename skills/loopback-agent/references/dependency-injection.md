# Dependency Injection

## Table of Contents

- [Import Rule](#import-rule)
- [Context and Binding Basics](#context-and-binding-basics)
- [Binding Value Types](#binding-value-types)
- [Binding Scopes](#binding-scopes)
- [Injection Decorators](#injection-decorators)
- [Tagging and Class Decoration](#tagging-and-class-decoration)
- [Application and Servers](#application-and-servers)
- [Components](#components)
- [Lifecycle Observers](#lifecycle-observers)
- [Tag-Based Discovery](#tag-based-discovery)
- [Key Rules](#key-rules)

## Import Rule

Everything flows upward through re-exports. `@agentback/context`
re-exports `@agentback/metadata`; `@agentback/core` re-exports
`@agentback/context`. In almost every file, a single import covers all
three layers:

```ts
import {
  Application,
  Component,
  LifeCycleObserver,
  Context,
  Binding,
  BindingKey,
  BindingScope,
  inject,
  injectable,
  bind,
  CoreBindings,
  CoreTags,
  createServiceBinding,
} from '@agentback/core';
```

Use `@agentback/context` directly only in packages that must not depend on
`@agentback/core`. ESM `.js` extensions are required on all relative
imports within the workspace.

## Context and Binding Basics

A `Context` is a hierarchical registry of `Binding`s. Child contexts inherit
bindings from their parent and can shadow them.

```ts
import {Context, BindingKey, BindingScope} from '@agentback/core';

// Standalone context
const ctx = new Context('app');

// Child context (inherits parent bindings)
const child = new Context(ctx, 'request');

// Strongly-typed binding key
export const GREETING_SERVICE = BindingKey.create<GreetingService>(
  'services.GreetingService',
);

// Register and resolve
ctx.bind(GREETING_SERVICE).toClass(GreetingService);
const svc = await ctx.get(GREETING_SERVICE);
const svcSync = ctx.getSync(GREETING_SERVICE);

// Find by tag or pattern
const bindings = ctx.findByTag('greeter');
const byPattern = ctx.find('services.*');
```

`Application` extends `Context` and is the root context for a running process.
The application itself is bound to `CoreBindings.APPLICATION_INSTANCE` and is
injectable anywhere in the container.

## Binding Value Types

```ts
// 1. Constant
ctx.bind('config.debug').to(true);

// 2. Class — instantiated with DI on first resolution
ctx.bind('services.Greeter').toClass(GreeterService);

// 3. Dynamic value — factory called on each resolution
ctx.bind('request.id').toDynamicValue(() => crypto.randomUUID());

// 4. Provider — factory class with DI support
class TokenProvider implements Provider<string> {
  constructor(@inject('config.secret') private secret: string) {}
  value() {
    return sign(this.secret);
  }
}
ctx.bind('auth.token').toProvider(TokenProvider);

// 5. Alias
ctx.bind('logger').toAlias(LOGGING_SERVICE);
```

## Binding Scopes

```ts
import {BindingScope, injectable} from '@agentback/core';

// Via decorator (preferred for classes)
@injectable({scope: BindingScope.SINGLETON})
export class ConfigService {
  /* ... */
}

// Via binding API
ctx
  .bind('services.ConfigService')
  .toClass(ConfigService)
  .inScope(BindingScope.SINGLETON);
```

Scopes: `TRANSIENT` (new instance per resolution, default for controllers),
`SINGLETON` (one shared instance, default for servers and `app.service()`
registrations), `APPLICATION` (pinned to the `Application` context), `REQUEST`
(one instance per request context).

## Injection Decorators

```ts
import {
  inject,
  Getter,
  ContextView,
  filterByTag,
  service,
  CoreBindings,
} from '@agentback/core';

class MyService {
  constructor(
    // Constructor injection — standard
    @inject(GREETING_SERVICE) private greeter: GreetingService,
    @inject(CoreBindings.APPLICATION_INSTANCE) private app: Application,
    // Getter — resolves lazily on each call; avoids circular dependencies
    @inject.getter('auth.token') private getToken: Getter<string>,
    // View — live set of all bindings matching a filter
    @inject.view(filterByTag('plugin')) private plugins: ContextView<Plugin>,
    // Service — resolve by class type instead of binding key
    @service(LogService) private log: LogService,
  ) {}
}

// Property injection — good for optional deps
class Greeter {
  @inject('config.debug', {optional: true})
  private debug?: boolean;
}
```

## Tagging and Class Decoration

`@injectable` (alias: `@bind`) attaches a binding specification — scope, tags,
and namespace — directly to a class. `createBindingFromClass` reads it when
registering the class.

```ts
import {
  injectable,
  bind,
  BindingScope,
  ContextTags,
} from '@agentback/core';

// Equivalent forms — @bind is the shorter alias
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: GREETING_SERVICE},
})
export class GreetingService {
  /* ... */
}

@bind({scope: BindingScope.SINGLETON, tags: {greeter: true}})
export class EnglishGreeter implements Greeter {
  /* ... */
}
```

`ContextTags.KEY` sets a stable lookup key so the binding can be retrieved by
that key even when registered by name.

## Application and Servers

`Application` is the root context and lifecycle coordinator. `RestApplication`
and `MCPApplication` are convenience subclasses:

```ts
import {Application} from '@agentback/core';
import {RestApplication} from '@agentback/rest'; // pre-registers RestServer + MiddlewareMixin
import {MCPApplication} from '@agentback/mcp'; // pre-mounts MCPComponent
import {MCPComponent} from '@agentback/mcp';

const restApp = new RestApplication({name: 'api'});
restApp.restController(HelloController); // tags binding with REST_CONTROLLER_TAG
restApp.component(MCPComponent); // hybrid REST + MCP

await restApp.start(); // init() → start() on all lifecycle observers
await restApp.stop(); // stop() in reverse order
```

**Registering artifacts imperatively:**

```ts
app.controller(MyController); // CoreTags.CONTROLLER, TRANSIENT scope
app.restController(MyRestController); // adds REST_CONTROLLER_TAG for discovery
app.service(MyService); // CoreTags.SERVICE, SINGLETON scope
app.server(MyServer); // CoreTags.SERVER + asLifeCycleObserver, SINGLETON
app.component(MyComponent); // recursively mounts the component
app.lifeCycleObserver(MyObserver); // CoreTags.LIFE_CYCLE_OBSERVER
```

Servers are bound under `servers.*` as singletons and are automatically tagged
as lifecycle observers.

## Components

A `Component` bundles related bindings so a feature can be plugged in with a
single `app.component(X)` call.

```ts
import {Component, createBindingFromClass} from '@agentback/core';

export class GreetingComponent implements Component {
  components = [LoggingComponent]; // nested — mounted first, recursively
  services = [TranslationService]; // auto-registered under services.*
  bindings = [
    // fine-grained key / scope control
    createBindingFromClass(EnglishGreeter, {key: 'greeters.en'}),
    createBindingFromClass(SpanishGreeter, {key: 'greeters.es'}),
  ];
  controllers = [GreetingController];
}

app.component(GreetingComponent);
```

`mountComponent` processes: `classes` → `providers` → `bindings` →
`controllers` → `servers` → `lifeCycleObservers` → `services` → `components`
(nested). A component that lists itself is skipped.

## Lifecycle Observers

Any class decorated with `@lifeCycleObserver` participates in
`init` → `start` → `stop` orchestration. The group name controls ordering.

```ts
import {
  lifeCycleObserver,
  LifeCycleObserver,
  BindingScope,
  ContextTags,
} from '@agentback/core';

@lifeCycleObserver('datasource', {
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: CACHE_OBSERVER_KEY},
})
export class CacheObserver implements LifeCycleObserver {
  async init() {
    /* warm caches */
  }
  async start() {
    /* open connections */
  }
  async stop() {
    /* flush + close */
  }
}

app.lifeCycleObserver(CacheObserver);
```

`LifeCycleObserverOptions.orderedGroups` controls group order (default:
`['server']`). Groups not listed run after ordered groups during `start` and
before them during `stop`. Within a group, observers run in parallel by default.

One-shot hooks:

```ts
app.onInit(async () => {
  /* once during init */
});
app.onStart(async () => {
  /* each start */
});
app.onStop(async () => {
  /* each stop */
});
```

## Tag-Based Discovery

**Adding a feature means adding a tagged binding.** Servers discover contributors
at `start()` via `ctx.findByTag(tag)` — no central registry to edit.

```ts
import {mcpServer, tool} from '@agentback/mcp';
import {z} from 'zod';

// @mcpServer() = @bind({tags: {mcpServer: true, [ContextTags.NAME]: name}})
// MCPServer calls ctx.findByTag('mcpServer') at start to enumerate tool providers.
@mcpServer()
export class WeatherService {
  @tool('forecast', {input: ForecastIn, output: ForecastOut})
  async forecast(input: z.infer<typeof ForecastIn>) {
    /* ... */
  }
}

// app.service() calls createServiceBinding(), which calls createBindingFromClass()
// and reads the @bind/@mcpServer metadata — the tag is applied automatically.
// Never call .tag() manually for @mcpServer or @lifeCycleObserver classes.
app.service(WeatherService);
```

Parallel pattern: `RestServer` uses `ctx.findByTag(REST_CONTROLLER_TAG)` to
mount routes; `LifeCycleObserverRegistry` uses
`filterByTag(CoreTags.LIFE_CYCLE_OBSERVER)` to drive `init`/`start`/`stop`.

## Key Rules

1. **Import from `@agentback/core`** — it re-exports `context` and
   `metadata`; downstream packages rarely need to depend on those directly.
2. **Use `BindingKey.create<T>(key)` for typed keys** — the type parameter is
   enforced at `ctx.get()` and `@inject()` call sites.
3. **Prefer `@injectable`/`@bind` on the class** over imperative
   `.inScope()/.tag()` — the metadata travels with the class and is applied
   automatically by `createBindingFromClass` / `createServiceBinding`.
4. **Never call `.tag()` manually for `@mcpServer` or `@lifeCycleObserver`
   classes** — registration helpers read the decorator metadata and tag the
   binding for you.
5. **Servers and lifecycle observers are singletons by default**; controllers
   are transient. Override with `@injectable({scope: ...})` or the
   `defaultScope` option on `createBindingFromClass`.
6. **For hybrid REST + MCP**, use `RestApplication` as the base and call
   `app.component(MCPComponent)` — do not instantiate two `Application`s.
