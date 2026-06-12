# @agentback/core

> `Application`, `Component`, `Server`, and lifecycle management — the
> framework layer above the DI container.

ESM port of [`@loopback/core`](https://github.com/loopbackio/loopback-next/tree/master/packages/core).
`Application` extends `Context` with typed registries for servers, components,
controllers, and services. Components bundle bindings together so features can
be plugged in with a single call. `LifeCycleObserver` coordinates `init` →
`start` → `stop` across all registered pieces.

Re-exports everything from `@agentback/context` (and transitively from
`@agentback/metadata`), so most packages only import from
`@agentback/core`.

## What it provides

- `Application` — the root `Context` subclass; hosts `start()` / `stop()` /
  `init()`, signal handling, and graceful shutdown.
- `Component` / `mountComponent` — plug in a bundle of bindings, controllers,
  servers, and lifecycle observers.
- `Server` — minimal interface for objects that participate in the lifecycle
  (`start` / `stop`).
- `LifeCycleObserver` / `LifeCycleObserverRegistry` / `asLifeCycleObserver` —
  ordered init/start/stop orchestration across all registered observers.
- `CoreBindings` / `CoreTags` — well-known binding keys and tag names
  (`application.instance`, `servers`, `components`, `controllers`, `services`,
  `lifeCycleObserver`, …).
- `ExtensionPoint` / `extensionPoint` / `extensions` — extension-point/extension
  pattern for pluggable feature sets.
- `createServiceBinding` / `ServiceOptions` — register an arbitrary class as a
  named service in the container.
- `isMain(import.meta)` — ESM equivalent of `require.main === module`.
- `mixinTarget` — utility for building mixin classes against `Application`.

## Usage

```ts
import {
  Application,
  Component,
  Server,
  CoreBindings,
} from '@agentback/core';

class PingServer implements Server {
  async start() {
    console.log('listening…');
  }
  async stop() {
    console.log('closed.');
  }
}

class PingComponent implements Component {
  servers = {ping: PingServer};
}

const app = new Application({name: 'my-app'});
app.component(PingComponent);

await app.start();
// -> 'listening…'
await app.stop();
// -> 'closed.'
```

Inject the application itself anywhere inside the container:

```ts
import {inject} from '@agentback/core';
import {CoreBindings} from '@agentback/core';

class MyService {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE) private app: Application,
  ) {}
}
```

## Layering

Depends on: `@agentback/context` (which re-exports `@agentback/metadata`).  
`@agentback/core` is the framework base that `rest`, `mcp`, `config`,
`authentication`, and every example depend on.
