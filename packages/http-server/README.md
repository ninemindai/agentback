# @agentback/http-server

> Thin HTTP/HTTPS server wrapper with graceful stop, used as the transport layer for all AgentBack servers.

Wraps Node's built-in `http`/`https` modules with a `start()`/`stop()` lifecycle and plugs in
[`stoppable`](https://github.com/hunterloftis/stoppable) for graceful shutdown — in-flight requests are
allowed to drain for up to `gracePeriodForClose` milliseconds before connections are force-closed.
Supports TCP ports, host binding, IPC (named pipe) paths, and all standard `net.Server` / `http.Server`
tuning properties (`keepAliveTimeout`, `headersTimeout`, `maxConnections`, `timeout`, …).

This package has no DI dependency — it is a plain Node.js class that any server layer (`@agentback/express`, `@agentback/rest`) wraps to gain lifecycle management.

## What it provides

- `HttpServer` — the core class; wraps a request listener in an HTTP or HTTPS server with `start()`/`stop()`
- `HttpServerOptions` — union of `HttpOptions` and `HttpsOptions` (both extend `ListenOptions`)
- `HttpOptions` — `{protocol?: 'http', port?, host?, gracePeriodForClose?, …}`
- `HttpsOptions` — `{protocol: 'https', …}` plus all `https.ServerOptions` (key/cert)
- `HttpProtocol` — `'http' | 'https'`
- `RequestListener` — `(req: IncomingMessage, res: ServerResponse) => void`
- `HttpServerProperties` — subset of `http.Server` tuning props available as options

## Usage

```ts
import {HttpServer} from '@agentback/http-server';

const server = new HttpServer(
  (req, res) => {
    res.end('hello');
  },
  {
    protocol: 'http',
    host: '127.0.0.1',
    port: 3000,
    gracePeriodForClose: 5000, // wait up to 5 s for in-flight requests on stop()
  },
);

await server.start();
console.log(server.url); // 'http://127.0.0.1:3000'
console.log(server.port); // 3000

await server.stop(); // drains connections, then closes
```

HTTPS — pass `protocol: 'https'` plus TLS options:

```ts
import {readFileSync} from 'fs';
import {HttpServer} from '@agentback/http-server';

const server = new HttpServer(handler, {
  protocol: 'https',
  port: 443,
  key: readFileSync('key.pem'),
  cert: readFileSync('cert.pem'),
  gracePeriodForClose: 10_000,
});
```

Port `0` (the default) lets the OS assign a free port — useful in tests:

```ts
const server = new HttpServer(handler); // port: 0
await server.start();
console.log(server.port); // e.g. 54321
```

## Layering

No `@agentback/*` runtime dependencies. Depends on `stoppable` (graceful stop) and `debug`.
Consumed by `@agentback/express` and, transitively, `@agentback/rest`.
