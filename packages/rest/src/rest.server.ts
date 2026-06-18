// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  config,
  Context,
  describeInjectedArguments,
  inject,
  resolveInjectedArguments,
} from '@agentback/context';
import {
  fromExpressRequest,
  getAuthenticationMetadata,
  normalizeAuthResult,
  resolveStrategy,
  type AuthenticationResult,
} from '@agentback/authentication';
import {
  AuthorizationDecision,
  buildAuthorizationContext,
  getAuthorizationMetadata,
  runAuthorization,
} from '@agentback/authorization';
import {SecurityBindings, UserProfile} from '@agentback/security';
import createError from 'http-errors';
import {CoreBindings, CoreTags, Server} from '@agentback/core';
// TYPE-ONLY imports — erased at compile time; safe to bundle for any runtime.
import type {ExpressMiddlewareFactory} from '@agentback/express';
import {
  assembleOpenApiSpec,
  buildErrorEnvelope,
  ErrorCodes,
  fileFieldsOf,
  getControllerSpec,
  lookupRouteSchemas,
  standardParse,
  OAS_ENHANCER_EXTENSION_POINT,
  type OASEnhancer,
  type OpenApiSpec,
  type RouteSchemas,
  type SchemaLike,
} from '@agentback/openapi';
import {
  InMemoryConfirmationStore,
  InMemoryIdempotencyStore,
  loggers,
  type ConfirmationStore,
  type IdempotencyStore,
} from '@agentback/common';
// TYPE-ONLY — erased at compile time; no runtime 'express' or 'http' import.
import type {Express, NextFunction, Request, Response} from 'express';
import type {Server as HttpServer} from 'http';
import {Readable} from 'node:stream';
import {
  RestBindings,
  RestMiddlewareGroups,
  type RestDispatchHook,
  type RestDispatchInfo,
} from './keys.js';
import {applyDispatchHooks, resolveDispatchHooks} from './dispatch-hooks.js';
import {
  enforceConfirmation as enforceConfirmationNeutral,
  executeIdempotent as executeIdempotentNeutral,
} from './confirm-idempotency.js';
import {
  DEFAULT_REST_CONFIG,
  type BodyParserConfig,
  type RestServerConfig,
} from './types.js';
import {invalidRequestBody} from './errors.js';
import {parseSection} from './validate-sections.js';
import {makeMultipartMiddleware} from './multipart.js';
import {isFileResponse, type FileResponse} from './file-response.js';
import {
  AX_SECTION_TAG,
  generateLlmsFullTxt,
  generateLlmsTxt,
  type AxSection,
} from './ax.js';
import {lookupSuccessStatus} from './route-meta.js';
import {SSE_FRAMER, JSONL_FRAMER} from './stream-framers.js';
import {collectRoutes} from './web/collect-routes.js';
import {assertPathSchemaMatch} from './route-path-validation.js';
import {Router} from './web/router.js';
import {RestHandler} from './web/rest-handler.js';
import {createFetchHost, type FetchHost} from './host/fetch.js';
import {createNodeListener} from './host/node.js';
import {writeWebResponseToNode} from './host/node-response.js';
import {
  collectWebMiddleware,
  runWebOnion,
  type WebMiddlewareEntry,
} from './web/middleware.js';
import {createCorsWebMiddleware} from './web/cors-middleware.js';
import type {RouteValue} from './web/route-value.js';
import {resolveControllerInstance} from './controller-resolver.js';

const log = loggers('agentback:rest:server');

// ---------------------------------------------------------------------------
// Lazy Node loaders — never called from fetchHandler()/the Web path.
// We avoid top-level `import express from 'express'` so a Cloudflare Worker
// that only uses fetchHandler() can bundle this file without pulling in Express
// or Node's `http` module.  In a plain Node process these are called once on
// first Express use and the result is memoised.
// ---------------------------------------------------------------------------

/** Return a Node `require` function resolved relative to this ESM file. */
function makeNodeRequire(): NodeRequire {
  // process.getBuiltinModule is Node 22.13+ only — never present in Workers.
  const nodeModule = (
    process as typeof process & {
      getBuiltinModule(id: string): unknown;
    }
  ).getBuiltinModule('node:module') as {
    createRequire(url: string): NodeRequire;
  };
  return nodeModule.createRequire(import.meta.url);
}

let _req: NodeRequire | undefined;
function nodeRequire(): NodeRequire {
  return (_req ??= makeNodeRequire());
}

// Cached lazily-loaded express default export (the factory + sub-parsers).
let _expressLib: typeof import('express') | undefined;
function loadExpress(): typeof import('express') {
  return (_expressLib ??= nodeRequire()('express') as typeof import('express'));
}

// Cached lazily-loaded @agentback/express helpers.
let _expressHelpers:
  | {
      registerExpressMiddleware: typeof import('@agentback/express').registerExpressMiddleware;
      toExpressMiddleware: typeof import('@agentback/express').toExpressMiddleware;
    }
  | undefined;
function loadExpressHelpers(): {
  registerExpressMiddleware: typeof import('@agentback/express').registerExpressMiddleware;
  toExpressMiddleware: typeof import('@agentback/express').toExpressMiddleware;
} {
  if (!_expressHelpers) {
    const mod = nodeRequire()('@agentback/express') as typeof import('@agentback/express');
    _expressHelpers = {
      registerExpressMiddleware: mod.registerExpressMiddleware,
      toExpressMiddleware: mod.toExpressMiddleware,
    };
  }
  return _expressHelpers;
}

// Cached lazily-loaded cors default export.
let _corsLib: typeof import('cors') | undefined;
function loadCors(): typeof import('cors') {
  return (_corsLib ??= nodeRequire()('cors') as typeof import('cors'));
}

// ---------------------------------------------------------------------------

/**
 * Build a runtime-neutral Web {@link globalThis.Request} view of an Express
 * request for {@link RestDispatchInfo.request}. Carries method, absolute URL
 * (from `protocol` + `Host` + `originalUrl`), and headers — everything a
 * dispatch hook reads — so one hook contract serves both the Express and Web
 * dispatch paths. The body is intentionally not attached: hooks observe, they
 * don't re-read the (already-parsed) request body.
 */
function webRequestFromExpress(req: Request): globalThis.Request {
  const host = req.get('host') ?? 'localhost';
  const url = `${req.protocol}://${host}${req.originalUrl ?? req.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  return new globalThis.Request(url, {method: req.method, headers});
}

export class RestServer implements Server {
  private _app?: Express;
  private httpServer?: HttpServer;
  private _listening = false;
  readonly config: Required<
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
    cors?: RestServerConfig['cors'];
    sse?: RestServerConfig['sse'];
    ax?: RestServerConfig['ax'];
    bodyParser?: RestServerConfig['bodyParser'];
    dispatch?: RestServerConfig['dispatch'];
    listener?: RestServerConfig['listener'];
  };

  /** Selected per-route dispatch pipeline; see {@link RestServerConfig.dispatch}. */
  protected readonly dispatchMode: 'express' | 'web';

  /** Selected HTTP listener; see {@link RestServerConfig.listener}. */
  protected readonly listenerMode: 'express' | 'native';

  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    protected context: Context,
    @config()
    cfg: RestServerConfig = {},
  ) {
    this.config = {
      ...DEFAULT_REST_CONFIG,
      ...cfg,
      openApiSpec: {
        ...DEFAULT_REST_CONFIG.openApiSpec,
        ...(cfg?.openApiSpec ?? {}),
      },
    };
    // Resolve the dispatch mode: explicit config wins; otherwise the
    // (test-only) AGENTBACK_REST_DISPATCH env var; otherwise 'express'. The env
    // override lets the ENTIRE existing test suite run through the Web pipeline
    // without editing a single test — the parity arbiter for web-dispatch mode.
    this.listenerMode = cfg.listener ?? 'express';
    // Native listener serves fetchHandler() directly, which always runs the Web
    // pipeline — so force web dispatch in native mode regardless of `dispatch`.
    this.dispatchMode =
      this.listenerMode === 'native' ? 'web' : resolveDispatchMode(cfg.dispatch);
    // Express is initialised lazily in ensureExpressApp() so that a Worker
    // using only fetchHandler() can import this module without pulling in the
    // Node `express` or `http` packages.  No Express work in the constructor.
  }

  /**
   * Return the Express app, creating and wiring it on first call (lazy init).
   *
   * Express is NOT initialised in the constructor so that a Cloudflare Worker
   * using only {@link fetchHandler} can import `RestServer` without pulling in
   * the Node `express` or `http` packages.  Every Express-path method goes
   * through this getter; {@link fetchHandler} must never call it.
   */
  private ensureExpressApp(): Express {
    if (!this._app) {
      const expressLib = loadExpress();
      const {toExpressMiddleware} = loadExpressHelpers();
      this._app = expressLib();
      // CORS and body parsing are themselves entries in the LB middleware chain
      // (tagged with groups), not bare `app.use` calls — so their order relative
      // to user middleware is governed by the chain's topological sort, and body
      // parsing is configurable beyond JSON. See registerBuiltinMiddleware.
      this.registerBuiltinMiddleware();
      // Mount the LB-style middleware chain as the FIRST (and only) app-level
      // handler, matching upstream LB4's ExpressServer ("1st Express
      // middleware"). `toExpressMiddleware` discovers and sorts the chain lazily
      // per request, so middleware bound later — via `app.middleware(...)` /
      // `app.expressMiddleware(...)` before `app.start()` — still participate.
      // Mounting here (not in `start()`) means it sits in FRONT of every route
      // mounted afterward, including ones added by `install*` helpers
      // (mcp-http's `/mcp`, rest-explorer, console, …) before `start()` runs —
      // otherwise those routes would shadow the chain and bypass it entirely.
      this._app.use(toExpressMiddleware(this.context));
    }
    return this._app;
  }

  /**
   * Register the built-in CORS and body-parsing middleware INTO the LB
   * middleware chain (not as bare `app.use`), each tagged with a group so the
   * chain's topological sort runs them in order — `cors` → `parseBody` → user
   * middleware (the default `middleware` group) — and so callers can position
   * their own middleware relative to them via {@link RestMiddlewareGroups}.
   *
   * Body parsing is configurable (`config.bodyParser`): JSON-only by default,
   * `false` to mount none, or any combination of json/urlencoded/text/raw so
   * the server accepts media types beyond `application/json`.
   */
  protected registerBuiltinMiddleware(): void {
    const {registerExpressMiddleware} = loadExpressHelpers();
    const corsLib = loadCors();
    const expressLib = loadExpress();
    if (this.config.cors) {
      registerExpressMiddleware(
        this.context,
        corsLib,
        this.config.cors === true ? undefined : this.config.cors,
        {
          injectConfiguration: false,
          key: 'middleware.cors',
          group: RestMiddlewareGroups.CORS,
          downstreamGroups: [
            RestMiddlewareGroups.PARSE_BODY,
            RestMiddlewareGroups.MIDDLEWARE,
          ],
        },
      );
    }

    const bp = this.config.bodyParser;
    if (bp === false) return; // explicit opt-out: no body parser at all
    // Unset → JSON-only default. Otherwise honor each enabled parser.
    const cfg: BodyParserConfig = bp ?? {json: true};
    this.registerBodyParser('json', expressLib.json, cfg.json ?? true);
    // Bare `true` → `{extended: true}`: `express.urlencoded(undefined)` logs the
    // Express 4 "undefined extended" deprecation, so supply the option explicitly.
    this.registerBodyParser(
      'urlencoded',
      expressLib.urlencoded,
      cfg.urlencoded === true ? {extended: true} : cfg.urlencoded,
    );
    this.registerBodyParser('text', expressLib.text, cfg.text);
    this.registerBodyParser('raw', expressLib.raw, cfg.raw);
  }

  /**
   * Register one Express body parser into the chain under the `parseBody`
   * group (after `cors`, before user middleware). `opt` of `false`/`undefined`
   * skips the parser; `true` uses the parser's defaults; an object passes
   * through as the parser's options.
   */
  private registerBodyParser<C>(
    name: string,
    factory: ExpressMiddlewareFactory<C>,
    opt: boolean | C | undefined,
  ): void {
    if (!opt) return;
    const {registerExpressMiddleware} = loadExpressHelpers();
    registerExpressMiddleware<C>(
      this.context,
      factory,
      opt === true ? undefined : opt,
      {
        injectConfiguration: false,
        key: `middleware.bodyParser.${name}`,
        group: RestMiddlewareGroups.PARSE_BODY,
        upstreamGroups: [RestMiddlewareGroups.CORS],
        downstreamGroups: [RestMiddlewareGroups.MIDDLEWARE],
      },
    );
  }

  get listening(): boolean {
    return this._listening;
  }

  /** Selected HTTP listener (`'express' | 'native'`); see {@link RestServerConfig.listener}. */
  get listener(): 'express' | 'native' {
    return this.listenerMode;
  }

  /**
   * Register a controller class. The class must already be bound in the
   * application context (or any ancestor); we look it up by class and
   * register routes.
   */
  controller(ctor: Function): void {
    const spec = getControllerSpec(ctor);
    const prefix = (this.config.basePath ?? '') + (spec.basePath ?? '');

    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [verb, operation] of Object.entries(
        item as Record<string, unknown>,
      )) {
        if (!operation || typeof operation !== 'object') continue;
        const op = operation as {operationId: string};
        const methodName = op.operationId.split('.').pop()!;
        const schemas = lookupRouteSchemas(ctor.prototype, methodName) ?? {};

        // Guardrail: URL placeholders must match the `path:` schema's keys.
        // Shared with the fetch/native path (collectRoutes) so the check is
        // enforced identically on every host — see route-path-validation.ts.
        assertPathSchemaMatch(ctor.name, methodName, verb, path, schemas);

        const route = prefix + toExpressPath(path);
        log.debug(
          'mounting %s %s -> %s.%s',
          verb,
          route,
          ctor.name,
          methodName,
        );

        const handler = this.makeHandler(ctor, methodName, schemas);
        const expressVerb = verb as
          | 'get'
          | 'post'
          | 'put'
          | 'patch'
          | 'delete'
          | 'head'
          | 'options';
        // A body with a `fileField()` gets a per-route multipart parser mounted
        // ahead of the handler: it streams files to the bound FileStore and
        // merges UploadedFile handles into req.body for Zod validation.
        //
        // In web-dispatch mode the Web `RestHandler` parses multipart itself
        // (via `parseWebMultipart` / `Request.formData()`), so we must NOT mount
        // multer ahead of it — multer would consume the stream first. The
        // web-mode handler streams the raw Express request into its Web Request
        // instead (see `webRequestForWebDispatch`). A route kept on Express in
        // web-mode (raw req/res injection, or a seam override) still needs
        // multer, so mount it whenever the handler is the Express one.
        const fileFields = schemas.body ? fileFieldsOf(schemas.body) : [];
        const handlerIsWeb =
          this.dispatchMode === 'web' &&
          !injectsRawExpressObjects(ctor, methodName) &&
          !this.overridesExpressDispatchSeam();
        if (fileFields.length && !handlerIsWeb) {
          this.ensureExpressApp()[expressVerb](
            route,
            makeMultipartMiddleware(fileFields, this.context),
            handler,
          );
        } else {
          this.ensureExpressApp()[expressVerb](route, handler);
        }
      }
    }
  }

  /**
   * Build an Express handler for a single route. Subclasses can override
   * this to substitute the entire per-request pipeline (or — more usefully —
   * override `dispatch` / `sendResult` / `sendError` for smaller surgical
   * changes while keeping the wiring intact).
   */
  protected makeHandler(
    ctor: Function,
    methodName: string,
    schemas: RouteSchemas,
  ) {
    const successStatus = lookupSuccessStatus(ctor, methodName);
    // Web-dispatch mode: route the matched request through the runtime-neutral
    // RestHandler pipeline instead of the Express invokeRoute path. Upload
    // routes (fileField body) now run on the Web path too — `parseWebMultipart`
    // streams each file to the bound FileStore via `Request.formData()`, the
    // runtime-neutral mirror of the Express multer parser.
    // Routes that reach for the raw Express request/response objects via
    // @inject(HTTP_REQUEST/HTTP_RESPONSE) are inherently Express-coupled — the
    // Web pipeline binds only WEB_REQUEST — so keep them on Express even in
    // web-mode (statically detectable from the method's injection metadata).
    const usesRawExpress = injectsRawExpressObjects(ctor, methodName);
    if (
      this.dispatchMode === 'web' &&
      !usesRawExpress &&
      !this.overridesExpressDispatchSeam()
    ) {
      return this.makeWebHandler(ctor, methodName, schemas, successStatus);
    }
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await this.dispatch(req, res, ctor, methodName, schemas);
        if (schemas.streamOf) {
          await this.sendStream(
            req,
            res,
            result,
            schemas.streamOf,
            successStatus,
            schemas.format ?? 'sse',
          );
        } else {
          this.sendResult(res, result, successStatus);
        }
      } catch (err) {
        next(err);
      }
    };
  }

  /**
   * Whether the concrete server class overrides any of the Express per-request
   * dispatch seam (`dispatch` / `invokeRoute` / `sendResult` / `sendStream` /
   * `sendError`). These are the documented Express-path subclassing hooks — a
   * subclass that customizes them has opted into the Express pipeline, so even
   * in web-mode we keep ITS routes on Express (the Web `RestHandler` doesn't
   * consult these methods). The base `RestServer` overrides nothing, so the
   * common case still takes the Web path. Cached: the class shape is fixed.
   */
  private _overridesSeam?: boolean;
  protected overridesExpressDispatchSeam(): boolean {
    if (this._overridesSeam === undefined) {
      const base = RestServer.prototype as unknown as Record<string, unknown>;
      const proto = Object.getPrototypeOf(this) as Record<string, unknown>;
      this._overridesSeam = [
        'dispatch',
        'invokeRoute',
        'sendResult',
        'sendStream',
        'sendError',
      ].some(name => proto[name] !== base[name]);
    }
    return this._overridesSeam;
  }

  /**
   * The shared runtime-neutral dispatcher used by web-dispatch mode and
   * {@link fetchHandler}. Stateless besides confirmation/idempotency-store
   * caches, so a single instance is safe to reuse across routes.
   */
  private _restHandler?: RestHandler;
  protected get restHandler(): RestHandler {
    return (this._restHandler ??= new RestHandler(this.context));
  }

  /**
   * Build an Express handler for web-dispatch mode. Express still matched the
   * route, so we don't re-route: we already know this route's
   * `{ctor, methodName, schemas, successStatus}`. We reconstruct a Web
   * `Request` from the (already-parsed) Express `req`, build a `RouteMatch` from
   * `req.params`, run the shared {@link RestHandler.dispatch}, and write the Web
   * `Response` back onto the Express `res` — including the streaming
   * `ReadableStream` body case.
   *
   * The critical subtlety: Express's body parser has already consumed the
   * request stream into `req.body`, so a naive Web `Request` would have an
   * EMPTY body and `RestHandler`'s `await req.json()` would read nothing. We
   * therefore re-serialize `req.body` back into the Web `Request` body (see
   * {@link webRequestForWebDispatch}).
   */
  protected makeWebHandler(
    ctor: Function,
    methodName: string,
    schemas: RouteSchemas,
    successStatus: number,
  ) {
    const value: RouteValue = {ctor, methodName, schemas, successStatus};
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const webReq = webRequestForWebDispatch(req);
        // Express already decoded `req.params`; RestHandler's RouteMatch expects
        // decoded param values (its own Router decodes too), so pass them as-is
        // — no double-decode.
        const match = {
          value,
          params: {...(req.params as Record<string, string>)},
        };
        const response = await this.restHandler.dispatch(match, webReq);
        await writeWebResponseToExpress(response, res);
      } catch (err) {
        next(err);
      }
    };
  }

  /**
   * Run a single request through auth → authz → input validation →
   * controller method → response validation. Returns the controller's
   * result. Override in a subclass to insert custom lifecycle steps
   * (e.g. audit logging, transaction boundaries, response envelopes).
   *
   * Cross-cutting concerns that need to *compose* (tracing + metering + …)
   * should prefer dispatch hooks over subclassing: bind a
   * {@link RestDispatchHook} tagged {@link REST_DISPATCH_HOOK_TAG} before
   * `app.start()`. Hooks wrap the whole pipeline below (the first-bound hook
   * is outermost); a subclass override that calls `super.dispatch` runs
   * outside the hook chain, so both seams work together.
   */
  protected async dispatch(
    req: Request,
    res: Response,
    ctor: Function,
    methodName: string,
    schemas: RouteSchemas,
  ): Promise<unknown> {
    // The per-request context is created BEFORE the hook chain so hooks can
    // observe request-scoped bindings (principals) via `info.ctx`.
    const reqCtx = new Context(this.context, `request-${Date.now()}`);
    const run = (): Promise<unknown> =>
      this.invokeRoute(req, res, ctor, methodName, schemas, reqCtx);

    const hooks = await this.resolveDispatchHooks();
    if (hooks.length === 0) return run();

    // Neutral info: a Web `Request` view of the Express `req` (method/url/
    // headers — the body is not consumed by hooks) and a neutral
    // `responseHeaders` collector. The Web `RestHandler` builds the same shape
    // so a hook runs at parity on both surfaces. No Express `res` is exposed.
    const responseHeaders = new Headers();
    const info: RestDispatchInfo = {
      request: webRequestFromExpress(req),
      responseHeaders,
      ctor,
      methodName,
      schemas,
      ctx: reqCtx,
    };
    try {
      return await applyDispatchHooks(hooks, info, run);
    } finally {
      // Flush hook-contributed headers onto the Express response. Runs on both
      // the success and error paths (mirroring how the Web path merges them
      // onto whatever Response it returns), so a header set before a thrown
      // refusal still reaches the client.
      responseHeaders.forEach((value, name) => res.setHeader(name, value));
    }
  }

  /**
   * Resolve the dispatch hooks bound under {@link REST_DISPATCH_HOOK_TAG}.
   * The resolved list is cached after the first lookup (first request) —
   * hooks must be bound before `app.start()`.
   */
  private dispatchHookCache?: RestDispatchHook[];
  protected async resolveDispatchHooks(): Promise<RestDispatchHook[]> {
    if (!this.dispatchHookCache) {
      this.dispatchHookCache = await resolveDispatchHooks(this.context);
    }
    return this.dispatchHookCache;
  }

  /**
   * The core per-request pipeline (extracted from `dispatch` so hooks can
   * wrap it): auth → authz → input validation → controller method →
   * response validation.
   */
  private async invokeRoute(
    req: Request,
    res: Response,
    ctor: Function,
    methodName: string,
    schemas: RouteSchemas,
    reqCtx: Context,
  ): Promise<unknown> {
    // Bind the raw Express request/response so handlers can opt in via
    // `@inject(RestBindings.HTTP_REQUEST, {optional: true})` — the seam for
    // file uploads, downloads, and streaming. Bound before auth so even
    // auth-less routes can reach them. Two cheap binds per request.
    reqCtx.bind(RestBindings.HTTP_REQUEST).to(req);
    reqCtx.bind(RestBindings.HTTP_RESPONSE).to(res);

    const auth = await this.authenticate(req, ctor, methodName);
    if (auth.user) reqCtx.bind(SecurityBindings.USER).to(auth.user);
    if (auth.clientApplication) {
      reqCtx
        .bind(SecurityBindings.CLIENT_APPLICATION)
        .to(auth.clientApplication);
    }
    await this.authorize(auth.user, ctor, methodName, reqCtx);

    // Safety gate AFTER auth/authz (an unauthorized caller learns nothing,
    // not even that confirmation exists) and BEFORE input validation (the
    // proposed payload is confirmed byte-identical, valid or not).
    if (schemas.confirm) {
      await this.enforceConfirmation(req, ctor, methodName, schemas.confirm);
    }

    const run = async (): Promise<unknown> => {
      const instance = (await this.resolveController(ctor)) as Record<
        string,
        Function
      >;

      const hasInput =
        schemas.body != null ||
        schemas.path != null ||
        schemas.query != null ||
        schemas.headers != null;
      const nonInjected: unknown[] = hasInput
        ? [buildInputBundle(req, schemas)]
        : [];

      const args = await resolveInjectedArguments(
        ctor.prototype,
        methodName,
        reqCtx,
        undefined,
        nonInjected,
      );
      const result = await (instance[methodName] as Function).apply(
        instance,
        args,
      );

      if (schemas.response) {
        const parsed = standardParse(schemas.response, result);
        if (!parsed.success) {
          log.debug(
            'response validation failed for %s.%s: %j',
            ctor.name,
            methodName,
            parsed.issues,
          );
        }
      }
      return result;
    };

    if (schemas.idempotency) {
      return this.executeIdempotent(
        req,
        res,
        ctor,
        methodName,
        schemas.idempotency,
        run,
      );
    }
    return run();
  }

  /**
   * `confirm:` routes: the first call (no `x-confirmation-token` header) is
   * refused with 409 `confirmation_required` carrying a single-use token
   * bound to the exact request payload; the identical retry with the token
   * executes. A mismatched/expired token is 409 `confirmation_invalid`.
   *
   * Delegates to the runtime-neutral {@link enforceConfirmationNeutral} (shared
   * with the Web {@link RestHandler}) with the Express request facts; behavior
   * is byte-identical to the inlined version it replaced.
   */
  protected async enforceConfirmation(
    req: Request,
    ctor: Function,
    methodName: string,
    confirm: NonNullable<RouteSchemas['confirm']>,
  ): Promise<void> {
    await enforceConfirmationNeutral({
      scope: `${ctor.name}.${methodName}`,
      facts: {
        method: req.method,
        path: req.path,
        params: req.params,
        query: req.query as Record<string, unknown>,
        body: req.body,
      },
      getHeader: name => req.get(name),
      store: await this.confirmationStore(),
      confirm,
    });
  }

  /**
   * `idempotency:` routes: replaying an `idempotency-key` returns the
   * original result without re-executing the handler (the response carries
   * `idempotency-replayed: true`); concurrent calls with one key share one
   * execution; errors are not cached. Without the header the route runs
   * normally unless `{required: true}`.
   *
   * Delegates to the runtime-neutral {@link executeIdempotentNeutral} (shared
   * with the Web {@link RestHandler}); the `replayed` flag it returns is
   * surfaced as the `idempotency-replayed` Express response header.
   */
  protected async executeIdempotent(
    req: Request,
    res: Response,
    ctor: Function,
    methodName: string,
    idempotency: NonNullable<RouteSchemas['idempotency']>,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const {replayed, result} = await executeIdempotentNeutral({
      scope: `${ctor.name}.${methodName}`,
      getHeader: name => req.get(name),
      store: await this.idempotencyStore(),
      idempotency,
      run,
    });
    if (replayed) res.setHeader('idempotency-replayed', 'true');
    return result;
  }

  private confirmationStoreCache?: ConfirmationStore;
  protected async confirmationStore(): Promise<ConfirmationStore> {
    if (!this.confirmationStoreCache) {
      this.confirmationStoreCache =
        (await this.context.get(RestBindings.CONFIRMATION_STORE, {
          optional: true,
        })) ?? new InMemoryConfirmationStore();
    }
    return this.confirmationStoreCache;
  }

  private idempotencyStoreCache?: IdempotencyStore;
  protected async idempotencyStore(): Promise<IdempotencyStore> {
    if (!this.idempotencyStoreCache) {
      this.idempotencyStoreCache =
        (await this.context.get(RestBindings.IDEMPOTENCY_STORE, {
          optional: true,
        })) ?? new InMemoryIdempotencyStore();
    }
    return this.idempotencyStoreCache;
  }

  /**
   * Send the dispatched result. Default: JSON with the success status;
   * `status === 204` returns an empty body. Override to wrap responses
   * in an envelope, negotiate content type, etc.
   */
  protected sendResult(
    res: Response,
    result: unknown,
    successStatus: number,
  ): void {
    if (isFileResponse(result)) {
      this.sendFile(res, result, successStatus);
      return;
    }
    if (successStatus !== 200) res.status(successStatus);
    if (successStatus === 204) {
      res.end();
    } else {
      res.json(result);
    }
  }

  /**
   * Stream a {@link FileResponse} (download). Sets `Content-Type` /
   * `Content-Disposition` / `Content-Length`, then writes the buffer or pipes
   * the stream. A stream error after headers are flushed destroys the socket
   * (same discipline as `sendStream`). `protected` so subclasses can adjust
   * headers (e.g. caching) or framing.
   */
  protected sendFile(
    res: Response,
    file: FileResponse,
    successStatus: number,
  ): void {
    if (file.contentType) res.type(file.contentType);
    if (file.filename) {
      const safe = file.filename.replace(/["\r\n]/g, '');
      res.setHeader(
        'Content-Disposition',
        `${file.disposition ?? 'attachment'}; filename="${safe}"`,
      );
    }
    if (file.size != null) res.setHeader('Content-Length', String(file.size));
    if (successStatus !== 200) res.status(successStatus);

    const body = file.body;
    if (Buffer.isBuffer(body)) {
      res.end(body);
      return;
    }
    body.on('error', () => {
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    body.pipe(res);
  }

  /**
   * Render an error response. Express invokes this via the final error
   * middleware; subclasses can override to customize the JSON shape or
   * negotiate content type per the request.
   */
  /**
   * Send a streaming response from an async-iterable handler result.
   *
   * Two wire formats share one pull/validate/cleanup loop, differing only in
   * how an item or an error is serialized to the wire (the `StreamFramer`):
   * `'sse'` (default) emits `text/event-stream` Server-Sent Events; `'jsonl'`
   * emits newline-delimited JSON (`application/jsonl`).
   *
   * Contract: the first item is pulled BEFORE headers are flushed, so an
   * error thrown before the first `yield` (auth, not-found) still surfaces
   * as a normal HTTP error status. After the flush this method never throws
   * — mid-stream failures are written as a terminal error record and the
   * stream ends. `protected` so subclasses can change the framing or add
   * formats.
   */
  protected async sendStream(
    _req: Request,
    res: Response,
    result: unknown,
    itemSchema: SchemaLike,
    successStatus = 200,
    format: 'sse' | 'jsonl' = 'sse',
  ): Promise<void> {
    const iterable = result as AsyncIterable<unknown> | null;
    if (!iterable || typeof iterable !== 'object') {
      throw createError(
        500,
        'Handler declared streamOf but did not return an async iterable.',
      );
    }
    const iteratorFactory = (iterable as AsyncIterable<unknown>)[
      Symbol.asyncIterator
    ];
    if (typeof iteratorFactory !== 'function') {
      throw createError(
        500,
        'Handler declared streamOf but did not return an async iterable.',
      );
    }
    const iterator = iteratorFactory.call(iterable);

    // Pull the first item before committing to the stream so immediate
    // failures keep proper HTTP status codes. Throws propagate to sendError.
    const first = await iterator.next();

    const framer = format === 'jsonl' ? JSONL_FRAMER : SSE_FRAMER;
    res.status(successStatus);
    for (const [name, value] of Object.entries(framer.headers)) {
      res.setHeader(name, value);
    }
    res.flushHeaders();

    let closed = false;
    const cleanup: (() => void)[] = [];
    const finish = () => {
      if (closed) return;
      closed = true;
      for (const fn of cleanup) fn();
      res.end();
    };
    // Client disconnect: stop iterating and let the generator's `finally`
    // blocks release upstream resources.
    res.on('close', () => {
      closed = true;
      for (const fn of cleanup) fn();
      void iterator.return?.();
    });

    // SSE-only heartbeat: JSONL has no comment-line convention.
    const pingMs = this.config.sse?.pingMs;
    if (format === 'sse' && pingMs && pingMs > 0) {
      const timer = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, pingMs);
      timer.unref?.();
      cleanup.push(() => clearInterval(timer));
    }

    const writeItem = (item: unknown): boolean => {
      const parsed = standardParse(itemSchema, item);
      if (!parsed.success) {
        // A stream that lies about its item type must not keep lying:
        // surface the issues and terminate.
        log.debug('stream item failed validation: %j', parsed.issues);
        res.write(
          framer.error({
            statusCode: 500,
            code: ErrorCodes.INTERNAL_ERROR,
            message: 'Stream item failed response validation.',
            details: parsed.issues,
          }),
        );
        return false;
      }
      res.write(framer.item(parsed.data));
      return true;
    };

    // Post-flush discipline: nothing below may throw out of this method —
    // the headers are committed, so the Express error path (status + JSON
    // body) is unusable.
    try {
      if (!first.done) {
        if (!writeItem(first.value)) return finish();
      }
      while (!closed) {
        const {value, done} = await iterator.next();
        if (done) break;
        if (!writeItem(value)) break;
      }
    } catch (err) {
      const e = err as Error;
      log.debug('stream handler threw mid-stream: %s', e.message);
      if (!closed) {
        const {issues, ...envelope} = buildErrorEnvelope(err);
        res.write(
          framer.error({
            statusCode: envelope.statusCode ?? 500,
            ...envelope,
            ...(issues ? {issues, details: issues} : {}),
          }),
        );
      }
    } finally {
      finish();
    }
  }

  protected sendError(_req: Request, res: Response, err: unknown): void {
    // If headers are already flushed (an SSE stream is live), a status+JSON
    // error response is impossible — destroy the socket instead of crashing
    // with ERR_HTTP_HEADERS_SENT.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    // Machine-actionable envelope: stable `code`, per-field `details`/`issues`,
    // the violated section's JSON `schema`, a `retryable` flag, and a one-line
    // remediation `hint` — so agents self-correct without a second round-trip.
    const envelope = buildErrorEnvelope(err);
    const {issues, ...rest} = envelope;
    res.status(envelope.statusCode ?? 500).json({
      error: {
        ...rest,
        // `details` is the historical key for the issues array; keep both.
        ...(issues ? {issues, details: issues} : {}),
      },
    });
  }

  /**
   * Run the authentication strategy declared by @authenticate, if any.
   * Returns the UserProfile on success; throws 401 on failure. `protected`
   * so subclasses can observe the resolved principal (e.g. usage metering).
   */
  protected async authenticate(
    req: Request,
    ctor: Function,
    methodName: string,
  ): Promise<AuthenticationResult> {
    const meta = getAuthenticationMetadata(ctor, methodName);
    if (!meta || meta.skip) return {};
    const strategy = await resolveStrategy(this.context, meta.strategy);
    if (!strategy) {
      throw createError(
        500,
        `Authentication strategy '${meta.strategy}' not registered.`,
      );
    }
    try {
      const result = normalizeAuthResult(
        await strategy.authenticate(fromExpressRequest(req), meta.options),
      );
      if (!result.user && !result.clientApplication) {
        throw createError(401, 'Unauthorized');
      }
      return result;
    } catch (err) {
      const e = err as Error & {statusCode?: number; status?: number};
      if (e.statusCode || e.status) throw e;
      throw createError(401, e.message || 'Unauthorized');
    }
  }

  /**
   * Apply @authorize metadata for the route. Throws 403 on DENY. Runs voters
   * against the per-request context so request-scoped bindings (tenant, client
   * application) are visible.
   */
  private async authorize(
    user: UserProfile | undefined,
    ctor: Function,
    methodName: string,
    reqCtx: Context,
  ): Promise<void> {
    const meta = getAuthorizationMetadata(ctor, methodName);
    if (!meta || meta.skip) return;
    const ctx = buildAuthorizationContext(user, `${ctor.name}.${methodName}`);
    const decision = await runAuthorization(ctx, meta, reqCtx);
    if (decision !== AuthorizationDecision.ALLOW) {
      throw createError(403, `Forbidden: not authorized for ${ctx.resource}.`);
    }
  }

  private resolveController<T>(ctor: Function): Promise<T> {
    return resolveControllerInstance<T>(this.context, ctor);
  }

  /**
   * Build and return the fully-assembled OpenAPI 3.1.1 document for the
   * currently-registered controllers.
   */
  async getApiSpec(): Promise<OpenApiSpec> {
    const controllers: Function[] = [];
    for (const b of this.context.findByTag(CoreTags.CONTROLLER)) {
      if (typeof b.valueConstructor === 'function') {
        controllers.push(b.valueConstructor);
      }
    }
    let spec = assembleOpenApiSpec(
      controllers,
      this.config.openApiSpec?.overrides as Partial<OpenApiSpec> | undefined,
    );

    // Apply every bound spec enhancer (info, consolidate, jwt-security, …).
    const enhancerBindings = this.context.findByTag({
      extensionFor: OAS_ENHANCER_EXTENSION_POINT,
    });
    for (const binding of enhancerBindings) {
      const enhancer = await this.context.get<OASEnhancer>(binding.key);
      spec = await enhancer.modifySpec(spec);
    }
    return spec;
  }

  /**
   * Register all controllers tagged in the context.
   */
  private mountAllControllers() {
    const bindings = this.context.findByTag(CoreTags.CONTROLLER);
    for (const b of bindings) {
      if (typeof b.valueConstructor === 'function') {
        this.controller(b.valueConstructor);
      }
    }
  }

  /**
   * Mount /openapi.json (and other framework routes) — call after all
   * controllers are bound.
   */
  private mountFrameworkRoutes() {
    const specPath =
      (this.config.basePath ?? '') +
      (this.config.openApiSpec?.path ?? '/openapi.json');
    // Native mode serves these through fetchHandler() only — never touch
    // ensureExpressApp() (it would pull the Node-only express runtime).
    const native = this.listenerMode === 'native';
    if (!native) {
      this.ensureExpressApp().get(specPath, async (_req, res, next) => {
        try {
          res.json(await this.getApiSpec());
        } catch (err) {
          next(err);
        }
      });
    }
    // Neutral fetch path: same spec, served as JSON via fetchHandler().
    this.addFetchHandler('GET', specPath, async () => {
      const spec = await this.getApiSpec();
      return globalThis.Response.json(spec);
    });

    this.mountAxRoutes(specPath);

    if (!native) {
      this.ensureExpressApp().use(
        (err: unknown, req: Request, res: Response, _next: NextFunction) => {
          this.sendError(req, res, err);
        },
      );
    }
  }

  /**
   * Mount the AX artifacts (`/llms.txt`, `/llms-full.txt`) — the same route
   * registry that emits /openapi.json describes itself to language models.
   * Disabled with `config.ax = false`. Components append sections by binding
   * {@link AxSection} values tagged {@link AX_SECTION_TAG}.
   */
  protected mountAxRoutes(specPath: string) {
    const ax = this.config.ax;
    if (ax === false) return;
    const basePath = this.config.basePath ?? '';
    const llmsTxtPath = basePath + (ax?.llmsTxtPath ?? '/llms.txt');
    const llmsFullTxtPath =
      basePath + (ax?.llmsFullTxtPath ?? '/llms-full.txt');

    const render = async (
      generate: typeof generateLlmsTxt,
    ): Promise<string> => {
      const spec = await this.getApiSpec();
      return generate(spec, {
        specPath,
        sections: await this.resolveAxSections(),
      });
    };
    const serve =
      (generate: typeof generateLlmsTxt) =>
      async (_req: Request, res: Response, next: NextFunction) => {
        try {
          res.type('text/plain; charset=utf-8').send(await render(generate));
        } catch (err) {
          next(err);
        }
      };
    if (this.listenerMode !== 'native') {
      this.ensureExpressApp().get(llmsTxtPath, serve(generateLlmsTxt));
      this.ensureExpressApp().get(llmsFullTxtPath, serve(generateLlmsFullTxt));
    }
    // Neutral fetch path: same AX documents via fetchHandler().
    const textResponse = async (body: string) =>
      new globalThis.Response(body, {
        headers: {'content-type': 'text/plain; charset=utf-8'},
      });
    this.addFetchHandler('GET', llmsTxtPath, async () =>
      textResponse(await render(generateLlmsTxt)),
    );
    this.addFetchHandler('GET', llmsFullTxtPath, async () =>
      textResponse(await render(generateLlmsFullTxt)),
    );
  }

  /** Resolve contributed {@link AxSection}s (bind order preserved). */
  protected async resolveAxSections(): Promise<AxSection[]> {
    const sections: AxSection[] = [];
    for (const binding of this.context.findByTag(AX_SECTION_TAG)) {
      sections.push(await this.context.get<AxSection>(binding.key));
    }
    return sections;
  }

  async start(): Promise<void> {
    // The LB-style middleware chain is mounted in the constructor (see there)
    // so it fronts every route — including `install*`-mounted ones registered
    // before `start()`. It still picks up middleware bound after construction
    // because `toExpressMiddleware` resolves the chain lazily per request.
    // In native mode the runtime-neutral fetchHandler() is the single router:
    // @api routes are collected from the DI context by collectRoutes(), so we
    // must NOT mount them on Express — ensureExpressApp() pulls the Node-only
    // express runtime via createRequire(), which is fatal on an edge isolate
    // (no `import.meta.url`, no express module). mountFrameworkRoutes() still
    // runs but registers only its fetch half in native mode.
    if (this.listenerMode !== 'native') {
      this.mountAllControllers();
    }
    this.mountFrameworkRoutes();
    // In native mode the Web pipeline can't serve Express-coupled routes (raw
    // `@inject(HTTP_REQUEST/HTTP_RESPONSE)` or a dispatch-seam override). Fail
    // loudly at start() — INCLUDING `listen:false` (edge/serverless), where no
    // listener binds and `startNativeListener()` never runs — so the misconfig
    // surfaces here instead of as a silent failure on the edge.
    if (this.listenerMode === 'native') {
      this.assertNoExpressCoupledRoute();
      // Build the fetch router now (memoized) so collectRoutes' placeholder/
      // schema validation runs at start() — matching the Express path's
      // start-time guarantee — even when listen:false (edge/serverless), where
      // it would otherwise first run on the initial request.
      this.fetchHandler();
    }
    // Serverless targets (Vercel, Lambda) own the HTTP listener: routes are
    // now fully mounted, so the caller exports `expressApp` (or `fetchHandler()`)
    // and we bind nothing.
    if (!this.config.listen) return;
    if (this.listenerMode === 'native') {
      await this.startNativeListener();
      return;
    }
    await new Promise<void>(resolve => {
      this.httpServer = this.ensureExpressApp().listen(
        this.config.port,
        this.config.host,
        () => {
          this._listening = true;
          resolve();
        },
      );
    });
  }

  /**
   * Experimental native listener (`rest.listener: 'native'`): serve
   * `fetchHandler()` through a Node `http` server via {@link createNodeListener}
   * instead of `expressApp.listen()`, making the runtime-neutral Router the
   * single source of truth — the same surface Bun/Fastify/Hono host. Throws if a
   * route opted into Express semantics (raw req/res injection or a dispatch-seam
   * override), since the Web pipeline can't serve those. See
   * docs/superpowers/specs/2026-06-16-fetch-seam-root-cutover.md.
   */
  protected async startNativeListener(): Promise<void> {
    // start() already asserts this in the native branch (incl. listen:false);
    // re-assert here so the guard holds if a subclass calls this directly.
    this.assertNoExpressCoupledRoute();
    const listener = createNodeListener(this.fetchHandler());
    const {createServer: createHttpServer} = (
      process as typeof process & {
        getBuiltinModule(id: string): unknown;
      }
    ).getBuiltinModule('node:http') as typeof import('http');
    await new Promise<void>(resolve => {
      this.httpServer = createHttpServer(listener).listen(
        this.config.port,
        this.config.host,
        () => {
          this._listening = true;
          resolve();
        },
      );
    });
  }

  /**
   * Throw if any route requires Express semantics the native Web pipeline can't
   * serve. Run in `start()` for native mode (incl. `listen:false`) so an edge
   * deploy fails at startup with a clear message rather than silently.
   */
  private assertNoExpressCoupledRoute(): void {
    const coupled = this.findExpressCoupledRoute();
    if (coupled) {
      throw new Error(
        `@agentback/rest: rest.listener: 'native' cannot serve route ` +
          `${coupled.ctor.name}.${coupled.methodName} — it ` +
          `${coupled.reason}, which requires the Express listener. Use ` +
          `rest.listener: 'express' (the default) for this app.`,
      );
    }
  }

  /**
   * Find the first registered `@api` route that is inherently Express-coupled
   * (raw `@inject(HTTP_REQUEST/HTTP_RESPONSE)`), or report the dispatch-seam
   * override. Used to fail loudly before binding the native listener.
   */
  private findExpressCoupledRoute():
    | {ctor: Function; methodName: string; reason: string}
    | undefined {
    if (this.overridesExpressDispatchSeam()) {
      // A subclass took over the Express dispatch seam; no single route to name.
      return {
        ctor: this.constructor,
        methodName: '(dispatch seam)',
        reason: 'overrides an Express dispatch seam (dispatch/sendResult/…)',
      };
    }
    for (const b of this.context.findByTag(CoreTags.CONTROLLER)) {
      const ctor = b.valueConstructor;
      if (typeof ctor !== 'function') continue;
      const spec = getControllerSpec(ctor);
      for (const item of Object.values(spec.paths ?? {})) {
        for (const operation of Object.values(item as Record<string, unknown>)) {
          if (!operation || typeof operation !== 'object') continue;
          const methodName = (operation as {operationId: string}).operationId
            .split('.')
            .pop()!;
          if (injectsRawExpressObjects(ctor, methodName)) {
            return {
              ctor,
              methodName,
              reason: 'injects the raw Express request/response',
            };
          }
        }
      }
    }
    return undefined;
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    await new Promise<void>((resolve, reject) => {
      this.httpServer!.close(err => (err ? reject(err) : resolve()));
    });
    this._listening = false;
  }

  /** Read URL — useful for clients. */
  get url(): string {
    const addr = this.httpServer?.address();
    if (addr && typeof addr === 'object') {
      return `http://${addr.address === '::' ? '127.0.0.1' : addr.address}:${addr.port}`;
    }
    return `http://${this.config.host}:${this.config.port}`;
  }

  /** Get the underlying express app (escape hatch). */
  get expressApp(): Express {
    return this.ensureExpressApp();
  }

  private _fetchHost?: FetchHost;

  // Exact-path and prefix-path handlers for the neutral fetch surface.
  // install*() helpers populate these BEFORE fetchHandler() is called so the
  // lazy build includes them. Adding after the cache is built invalidates it.
  private readonly _fetchExact: Array<{
    method: string;
    path: string;
    fn: (req: globalThis.Request) => Promise<globalThis.Response>;
  }> = [];
  private readonly _fetchPrefixes: Array<{
    prefix: string;
    fn: (suffix: string) => Promise<globalThis.Response | undefined>;
  }> = [];

  /**
   * Register an exact-path handler on the neutral {@link fetchHandler} surface
   * (for HTML shells, redirects, etc.). Complement to {@link addFetchPrefix}.
   * Call before the first `fetchHandler()` invocation (i.e. before
   * `installFastifyHost` / `Bun.serve`). `method` is case-insensitive.
   */
  addFetchHandler(
    method: string,
    path: string,
    fn: (req: globalThis.Request) => Promise<globalThis.Response>,
  ): void {
    this._fetchExact.push({method: method.toUpperCase(), path, fn});
    this._fetchHost = undefined;
  }

  /**
   * Register a prefix-based file handler on the neutral {@link fetchHandler}
   * surface. `prefix` is matched against the request pathname; `fn` receives
   * the portion of the pathname after the prefix (the suffix, always starting
   * with `/` or empty). Return `undefined` to fall through to the next handler.
   * Intended for bundled static asset directories (use {@link serveStaticDir}).
   */
  addFetchPrefix(
    prefix: string,
    fn: (suffix: string) => Promise<globalThis.Response | undefined>,
  ): void {
    this._fetchPrefixes.push({prefix, fn});
    this._fetchHost = undefined;
  }

  /**
   * Runtime-neutral fetch handler for this app's `@api` routes — the same
   * routing + Zod validation + DI + error-envelope pipeline as the Express path
   * (via RestHandler), as `fetch(Request): Promise<Response>` for Web hosts
   * (Bun/Deno/Workers/tests). Additive: the Express server is unchanged.
   * Authentication + authorization, streaming, dispatch hooks, and
   * confirmation + idempotency all run at parity with the Express path.
   * Built lazily from the registry on first call (after controllers are
   * registered / after start()). Exact handlers (addFetchHandler) and prefix
   * handlers (addFetchPrefix) registered before this call are folded into the
   * 404 fallback, so UI assets are served alongside @api routes.
   */
  fetchHandler(): FetchHost {
    if (!this._fetchHost) {
      const router = new Router<RouteValue>();
      for (const r of collectRoutes(this.context, this.config.basePath ?? '')) {
        router.add(r);
      }

      // Snapshot the raw-route arrays so the notFound closure is stable even if
      // more entries are added after this call (they'd bust the cache anyway).
      const exactEntries = [...this._fetchExact];
      const prefixEntries = [...this._fetchPrefixes];

      // When no raw routes are registered, fall through to createFetchHost's
      // built-in 404 (avoids an unnecessary async closure per miss).
      const notFound =
        exactEntries.length > 0 || prefixEntries.length > 0
          ? async (
              req: globalThis.Request,
            ): Promise<globalThis.Response> => {
              const {pathname} = new URL(req.url);

              // Exact handlers are checked first (priority over prefix matches).
              for (const e of exactEntries) {
                if (e.method === req.method.toUpperCase() && pathname === e.path) {
                  return e.fn(req);
                }
              }

              // Prefix handlers: longest matching prefix wins (insertion order
              // is user-controlled; document that specificity is caller's
              // responsibility).
              for (const p of prefixEntries) {
                if (
                  pathname === p.prefix ||
                  pathname.startsWith(p.prefix + '/')
                ) {
                  const suffix = pathname.slice(p.prefix.length) || '/';
                  const res = await p.fn(suffix);
                  if (res !== undefined) return res;
                }
              }

              return new globalThis.Response(
                JSON.stringify({
                  error: {code: 'not_found', message: 'Not Found'},
                }),
                {status: 404, headers: {'content-type': 'application/json'}},
              );
            }
          : undefined;

      const core = createFetchHost({
        router,
        dispatch: new RestHandler(this.context).dispatch,
        notFound,
      });

      // The runtime-neutral Web middleware onion (additive; the Express chain is
      // untouched). Built once, lazily, like the route table: the built-in CORS
      // entry (when `cors` is configured) plus any user `app.webMiddleware`
      // entries collected from the context. `runWebOnion` group-sorts them
      // (parity with the Express chain) and short-circuits when an entry returns
      // a Response without calling `next`. With zero entries, `fetchHandler()`
      // still works — the onion folds straight to `core.fetch`.
      let entries: Promise<WebMiddlewareEntry[]> | undefined;
      const collect = (): Promise<WebMiddlewareEntry[]> => {
        if (!entries) {
          entries = collectWebMiddleware(this.context).then(userEntries => {
            const builtins: WebMiddlewareEntry[] = [];
            if (this.config.cors) {
              builtins.push(createCorsWebMiddleware(this.config.cors));
            }
            return [...builtins, ...userEntries];
          });
        }
        return entries;
      };

      this._fetchHost = {
        // The Web onion deals in the global (WHATWG) Request/Response types;
        // use `globalThis.*` to be explicit and match the Web-host contract.
        fetch: async (
          req: globalThis.Request,
        ): Promise<globalThis.Response> => {
          const list = await collect();
          if (list.length === 0) return core.fetch(req);
          return runWebOnion(list, req, this.context, () => core.fetch(req));
        },
      };
    }
    return this._fetchHost;
  }

  /** Get the application context (used by extensions for binding lookups). */
  get appContext(): Context {
    return this.context;
  }
}

/**
 * Resolve the per-route dispatch mode. Explicit config wins; otherwise the
 * test-only `AGENTBACK_REST_DISPATCH` env var (`web` | `express`) supplies the
 * default; otherwise `'express'` (zero behavior change — the rollback path).
 */
function resolveDispatchMode(explicit?: 'express' | 'web'): 'express' | 'web' {
  if (explicit) return explicit;
  return process.env.AGENTBACK_REST_DISPATCH === 'web' ? 'web' : 'express';
}

/**
 * Whether `ctor.methodName` injects the raw Express request/response objects
 * (`RestBindings.HTTP_REQUEST` / `HTTP_RESPONSE`) at any parameter slot. Such a
 * route is Express-coupled and stays on the Express path even in web-mode.
 */
function injectsRawExpressObjects(ctor: Function, methodName: string): boolean {
  const rawKeys = new Set<string>([
    RestBindings.HTTP_REQUEST.key,
    RestBindings.HTTP_RESPONSE.key,
  ]);
  const injections = describeInjectedArguments(ctor.prototype, methodName);
  return injections.some(inj => {
    // The array is sparse for non-injected parameter slots — skip the holes.
    if (!inj) return false;
    const sel = inj.bindingSelector;
    const key =
      typeof sel === 'string'
        ? sel
        : sel && typeof sel === 'object' && 'key' in sel
          ? (sel as {key: string}).key
          : undefined;
    return key != null && rawKeys.has(key);
  });
}

/**
 * Build a Web {@link globalThis.Request} for web-dispatch delegation. Unlike
 * {@link webRequestFromExpress} (which is for dispatch-hook OBSERVATION and
 * deliberately omits the body), this RECONSTRUCTS the body: by the time a route
 * handler runs, Express's body parser has consumed the request stream into
 * `req.body`, so the original Web body is empty. When `req.body` is present and
 * looks like a JSON payload (object/array — the body-parser default), we
 * re-serialize it so `RestHandler`'s `await req.json()` reads the same data the
 * Express path reads off `req.body`. Headers (auth / confirmation / idempotency)
 * are preserved.
 */
function webRequestForWebDispatch(req: Request): globalThis.Request {
  const host = req.get('host') ?? 'localhost';
  const url = `${req.protocol}://${host}${req.originalUrl ?? req.url}`;
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }

  const init: RequestInit = {method: req.method, headers};
  const method = req.method.toUpperCase();
  const contentType = (req.get('content-type') ?? '').toLowerCase();
  if (method !== 'GET' && method !== 'HEAD') {
    if (contentType.includes('multipart/form-data')) {
      // Multipart: no body parser ran in web-mode (multer is intentionally not
      // mounted ahead of the Web handler — see makeRoutes), so the raw Express
      // request stream is still readable. Pipe it into the Web Request so
      // RestHandler's `parseWebMultipart` (`Request.formData()`) reads the
      // original multipart body and streams each file to the FileStore itself.
      init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
      // undici requires duplex for a streaming request body.
      (init as {duplex?: string}).duplex = 'half';
    } else if (req.body != null) {
      // Re-serialize the parsed JSON body so RestHandler's `await req.json()`
      // reads the SAME value the Express path validates off `req.body`.
      // `express.json` yields an object/array (it sets `{}` for an empty body),
      // serialized verbatim — including `{}`, so the Web path's missing-field
      // issue path matches Express's (validating `{}` vs `undefined` against a
      // `z.object` produces different Zod issues).
      const body = req.body;
      const isJsonLike = typeof body === 'object' && !Buffer.isBuffer(body);
      if (isJsonLike) {
        init.body = JSON.stringify(body);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
      }
    }
  }
  return new globalThis.Request(url, init);
}

/**
 * Write a Web {@link globalThis.Response} back onto the Express {@link Response}
 * — the web-dispatch counterpart of `sendResult`/`sendStream`/`sendError`,
 * which `host/node.ts` delegates to `@hono/node-server` for the standalone
 * fetch host. Express's `Response` extends Node's `ServerResponse`, so this just
 * delegates to the shared {@link writeWebResponseToNode} (also used by the
 * Fastify host adapter).
 */
async function writeWebResponseToExpress(
  response: globalThis.Response,
  res: Response,
): Promise<void> {
  await writeWebResponseToNode(res, response);
}

/**
 * Convert OpenAPI-style path templates `/foo/{name}` to express `/foo/:name`.
 */
function toExpressPath(p: string): string {
  return p.replace(/\{([^}]+)\}/g, ':$1');
}

/** Extract `{name}` placeholders from an OpenAPI-style path template. */
/**
 * Validate the four input slots and assemble the `{body, path, query, headers}`
 * bundle in the order the schemas were declared. Throws a 422 / 400 with Zod
 * issues attached on the first failure.
 */
function buildInputBundle(
  req: Request,
  schemas: RouteSchemas,
): Record<string, unknown> {
  const bundle: Record<string, unknown> = {};
  if (schemas.path) {
    bundle.path = parseSection(
      'path',
      req.params as Record<string, unknown>,
      schemas.path,
    );
  }
  if (schemas.query) {
    bundle.query = parseSection(
      'query',
      req.query as Record<string, unknown>,
      schemas.query,
    );
  }
  if (schemas.headers) {
    // Express lowercases header names; normalize the incoming map so schemas
    // can use natural lowercase keys without per-request bookkeeping.
    const headers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = v;
    }
    bundle.headers = parseSection('headers', headers, schemas.headers);
  }
  if (schemas.body) {
    const parsed = standardParse(schemas.body, req.body);
    if (!parsed.success) {
      throw invalidRequestBody(parsed.issues, schemas.body);
    }
    bundle.body = parsed.data;
  }
  return bundle;
}

// Re-export for legacy consumers; type-only.
export type {SchemaLike};
