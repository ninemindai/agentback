// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {CorsOptions} from 'cors';

/** Options for each built-in body parser — the matching Express parser's. */
type JsonOptions = NonNullable<Parameters<typeof import('express').json>[0]>;
type UrlencodedOptions = NonNullable<
  Parameters<typeof import('express').urlencoded>[0]
>;
type TextOptions = NonNullable<Parameters<typeof import('express').text>[0]>;
type RawOptions = NonNullable<Parameters<typeof import('express').raw>[0]>;

/**
 * Request body parsing. Each parser only acts on bodies whose `Content-Type`
 * it recognizes (Express skips non-matching types), so several can be enabled
 * together. JSON is on by default; enable `text` / `urlencoded` / `raw` to
 * accept other media types. Each field takes `true` (parser defaults) or the
 * matching Express parser's options, e.g. `{text: {type: 'text/csv'}}` or
 * `{raw: {type: 'application/octet-stream', limit: '5mb'}}`.
 */
export interface BodyParserConfig {
  /** `application/json`. Default: enabled. Set `false` to disable. */
  json?: boolean | JsonOptions;
  /** `application/x-www-form-urlencoded`. Default: disabled. */
  urlencoded?: boolean | UrlencodedOptions;
  /** `text/*`. Default: disabled. */
  text?: boolean | TextOptions;
  /** Raw `Buffer` for unmatched types (default `application/octet-stream`). */
  raw?: boolean | RawOptions;
}

export interface RestServerConfig {
  port?: number;
  host?: string;
  basePath?: string;
  /**
   * Whether `start()` binds a TCP listener. Default `true` — the server calls
   * `app.listen(port, host)` like a normal long-running process.
   *
   * Set to `false` for serverless / FaaS targets (Vercel, AWS Lambda) where
   * the platform owns the HTTP listener: `start()` still mounts all
   * middleware, controllers, and framework routes, but skips `app.listen`.
   * Boot the app, then hand the platform the fully-mounted Express instance:
   *
   * ```ts
   * const app = new RestApplication({rest: {listen: false}});
   * app.restController(MyController);
   * await app.start();
   * export default (await app.restServer).expressApp;
   * ```
   */
  listen?: boolean;
  openApiSpec?: {
    /** URL path where the OpenAPI document is served. Default '/openapi.json'. */
    path?: string;
    /** Static spec values to merge into the auto-assembled doc. */
    overrides?: Record<string, unknown>;
  };
  /**
   * Enable CORS for every route.
   *
   * - Omit (or set to `false`) — no CORS middleware is mounted.
   * - `true` — mount the `cors` package with its defaults (`origin: '*'`).
   * - Object — passed through to `cors(...)`; full options at
   *   https://github.com/expressjs/cors#configuration-options.
   *
   * For per-route or path-prefixed CORS, register middleware manually via
   * `app.middleware(...)`.
   */
  cors?: boolean | CorsOptions;
  /**
   * Request body parsing. See {@link BodyParserConfig}. Omit for JSON-only
   * (the default); set `false` to mount no parser at all (e.g. to consume the
   * raw request stream yourself, or accept arbitrary media types downstream).
   *
   * Parsing runs inside the middleware chain under the `parseBody` group —
   * after `cors`, before your `app.middleware(...)` — so middleware and route
   * handlers observe a populated `req.body`. Position custom middleware around
   * it with the {@link RestMiddlewareGroups} names.
   */
  bodyParser?: false | BodyParserConfig;
  /**
   * AX (agent experience) artifacts. By default the server serves
   * `/llms.txt` (compact endpoint index) and `/llms-full.txt` (full
   * per-endpoint schemas), generated from the same route registry as
   * /openapi.json. Set to `false` to disable, or override the paths.
   * Components can append sections by binding {@link AxSection} values
   * tagged `AX_SECTION_TAG`.
   */
  ax?:
    | false
    | {
        /** URL path for the compact index. Default '/llms.txt'. */
        llmsTxtPath?: string;
        /** URL path for the expanded document. Default '/llms-full.txt'. */
        llmsFullTxtPath?: string;
      };
  /**
   * Which dispatch pipeline each `@api` route runs through.
   *
   * - `'express'` (default) — the classic Express per-route handler
   *   (`RestServer.invokeRoute` → `sendResult`/`sendStream`/`sendError`).
   * - `'web'` — Express still matches routes, but each matched request is
   *   converted to a Web `Request`, run through the runtime-neutral
   *   {@link RestHandler} pipeline (the same one `fetchHandler()` uses), and the
   *   resulting Web `Response` is written back to the Express `res`. Behavior is
   *   at parity with `'express'`; the flag exists so the Web pipeline can become
   *   the proven default before the Express path is removed.
   *
   * Routes whose body uses `fileField()` (multipart uploads) and `fileResponse`
   * downloads always stay on the Express path even in `'web'` mode — the Web
   * pipeline doesn't yet stream multipart uploads (Stage 3).
   *
   * When unset, the `AGENTBACK_REST_DISPATCH` env var (test-only escape hatch:
   * `web` | `express`) selects the default; otherwise `'express'`.
   */
  dispatch?: 'express' | 'web';
  /**
   * Which HTTP listener `start()` binds. **Experimental** — the root-cutover
   * prototype (see docs/superpowers/specs/2026-06-16-fetch-seam-root-cutover.md).
   *
   * - `'express'` (default) — `start()` binds `expressApp.listen(...)`; Express
   *   owns routing. All features work, including `@agentback/mcp-http` and raw
   *   `@inject(HTTP_REQUEST/HTTP_RESPONSE)` routes.
   * - `'native'` — `start()` serves `fetchHandler()` directly via a Node
   *   `http.createServer(createNodeListener(...))`, making the runtime-neutral
   *   Router the single source of truth (parity with how Bun/Fastify/Hono host
   *   the app). `@api` routes, `/openapi.json`, `/llms.txt`, and the `install*`
   *   UIs are served; **`mcp-http` and raw-req/res routes are unsupported** and
   *   `start()` throws if such a route is registered.
   *
   * `'native'` implies the `'web'` dispatch pipeline regardless of `dispatch`.
   */
  listener?: 'express' | 'native';
  /** Server-sent events (stream routes declared with `streamOf:`). */
  sse?: {
    /**
     * Heartbeat interval in ms — writes `: ping` comment frames to defeat
     * idle-connection proxies. Off when omitted.
     */
    pingMs?: number;
  };
}

export const DEFAULT_REST_CONFIG: Required<
  Omit<
    RestServerConfig,
    | 'openApiSpec'
    | 'cors'
    | 'sse'
    | 'ax'
    | 'bodyParser'
    | 'dispatch'
    | 'listener'
  >
> & {
  openApiSpec: NonNullable<RestServerConfig['openApiSpec']>;
  cors: RestServerConfig['cors'];
  sse?: RestServerConfig['sse'];
  ax?: RestServerConfig['ax'];
  bodyParser?: RestServerConfig['bodyParser'];
} = {
  port: 3000,
  host: '127.0.0.1',
  basePath: '',
  listen: true,
  openApiSpec: {
    path: '/openapi.json',
  },
  cors: undefined,
};
