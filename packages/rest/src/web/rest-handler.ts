// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Context, resolveInjectedArguments} from '@agentback/context';
import {resolveControllerInstance} from '../controller-resolver.js';
import {
  AgentError,
  buildErrorEnvelope,
  ErrorCodes,
  standardParse,
  type RouteSchemas,
  type SchemaLike,
} from '@agentback/openapi';
import {
  fromWebRequest,
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
import {SecurityBindings, type UserProfile} from '@agentback/security';
import createError from 'http-errors';
import {loggers} from '@agentback/common';
import {RestBindings} from '../keys.js';
import {invalidRequestBody} from '../errors.js';
import {parseSection} from '../validate-sections.js';
import type {Dispatch} from './dispatch.js';
import type {RouteMatch} from './router.js';
import type {RouteValue} from './route-value.js';
import {
  SSE_FRAMER,
  JSONL_FRAMER,
  type StreamFramer,
} from '../stream-framers.js';

const STREAM_ENCODER = new TextEncoder();

const log = loggers('agentback:rest:web-handler');

function queryObject(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

/**
 * Runtime-neutral REST dispatcher: turns a matched {@link RouteValue} + a Web
 * `Request` into a Web `Response`, reusing the SAME validation, DI resolution,
 * and error-envelope logic as the Express {@link RestServer}. Wrapped in a
 * {@link Dispatch} contract so a {@link FetchHost} (Workers/Deno/Bun/tests) can
 * drive it directly. Authentication + authorization run at parity with the
 * Express path (same helpers, same 401/403 envelope); dispatch hooks,
 * idempotency, confirmation, and uploads are deferred.
 */
export class RestHandler {
  constructor(private readonly context: Context) {}

  readonly dispatch: Dispatch<RouteValue> = async (match, req) => {
    try {
      return await this.run(match, req);
    } catch (err) {
      return this.toErrorResponse(err);
    }
  };

  private async run(
    match: RouteMatch<RouteValue>,
    req: Request,
  ): Promise<Response> {
    const {ctor, methodName, schemas, successStatus} = match.value;
    const reqCtx = new Context(this.context, 'web-request');
    // Bind the Web Request under WEB_REQUEST (not HTTP_REQUEST, which is the
    // Express surface); inject with {optional: true} — absent on the Express path.
    reqCtx.bind(RestBindings.WEB_REQUEST).to(req);

    // Auth/authz BEFORE input validation (mirrors RestServer.invokeRoute): an
    // unauthorized caller learns nothing from a 401, not even whether its body
    // was well-formed. A thrown 401/403 propagates to `dispatch`'s try/catch →
    // `toErrorResponse` → `buildErrorEnvelope`, the SAME envelope the Express
    // path emits via `sendError`.
    const auth = await this.authenticate(req, ctor, methodName);
    if (auth.user) reqCtx.bind(SecurityBindings.USER).to(auth.user);
    if (auth.clientApplication) {
      reqCtx
        .bind(SecurityBindings.CLIENT_APPLICATION)
        .to(auth.clientApplication);
    }
    await this.authorize(auth.user, ctor, methodName, reqCtx);

    const hasInput =
      schemas.body != null ||
      schemas.path != null ||
      schemas.query != null ||
      schemas.headers != null;
    const nonInjected: unknown[] = hasInput
      ? [await this.buildBundle(match, req, schemas)]
      : [];

    const instance = (await this.resolveController(ctor)) as Record<
      string,
      Function
    >;
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

    if (schemas.streamOf) {
      const iterator = this.toAsyncIterator(result);
      // Pull the first item BEFORE committing to the stream so an immediate
      // throw surfaces as a proper-status error Response (propagating to the
      // `dispatch` try/catch → `toErrorResponse`), not a half-open stream.
      const first = await iterator.next();
      return this.toStreamResponse(
        iterator,
        first,
        schemas.streamOf,
        successStatus,
        schemas.format ?? 'sse',
      );
    }

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
    return this.toResultResponse(result, successStatus);
  }

  private async buildBundle(
    match: RouteMatch<RouteValue>,
    req: Request,
    schemas: RouteSchemas,
  ): Promise<Record<string, unknown>> {
    const bundle: Record<string, unknown> = {};
    if (schemas.path) {
      bundle.path = parseSection('path', match.params, schemas.path);
    }
    if (schemas.query) {
      bundle.query = parseSection(
        'query',
        queryObject(new URL(req.url)),
        schemas.query,
      );
    }
    if (schemas.headers) {
      // Web `Headers` are already lowercased — matching the Express path's
      // explicit `k.toLowerCase()` normalization — so schemas can use natural
      // lowercase keys on both surfaces.
      const headers: Record<string, unknown> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      bundle.headers = parseSection('headers', headers, schemas.headers);
    }
    if (schemas.body) {
      const raw = await req.json().catch(() => undefined);
      const parsed = standardParse(schemas.body, raw);
      if (!parsed.success) {
        throw invalidRequestBody(parsed.issues, schemas.body);
      }
      bundle.body = parsed.data;
    }
    return bundle;
  }

  /**
   * Validate that a `streamOf` handler returned an async iterable and return
   * its iterator. Mirrors {@link RestServer.sendStream}'s guard — a non-iterable
   * throws a 500 that propagates to {@link toErrorResponse} (proper status,
   * since the first item hasn't been pulled yet).
   */
  private toAsyncIterator(result: unknown): AsyncIterator<unknown> {
    const iterable = result as AsyncIterable<unknown> | null;
    const factory =
      iterable != null && typeof iterable === 'object'
        ? (iterable as AsyncIterable<unknown>)[Symbol.asyncIterator]
        : undefined;
    if (typeof factory !== 'function') {
      throw new AgentError(
        'Handler declared streamOf but did not return an async iterable.',
        {status: 500, code: ErrorCodes.INTERNAL_ERROR},
      );
    }
    return factory.call(iterable);
  }

  /**
   * Stream an `AsyncIterable` to a Web {@link Response} whose body is a
   * `ReadableStream`. Parity with {@link RestServer.sendStream}: the first item
   * is pulled by the caller (so immediate throws keep proper status); each item
   * is validated against `itemSchema` and framed; an item-validation failure or
   * a mid-stream throw is written as a terminal `framer.error(...)` record and
   * the stream closes. `cancel()` calls `iterator.return?.()` so a client
   * disconnect releases upstream resources.
   *
   * NOTE: the SSE keep-alive ping ({@link RestServer} reads `config.sse.pingMs`)
   * is deferred here — {@link RestHandler} has no config seam, and the ping is a
   * keep-alive, not content parity.
   */
  private toStreamResponse(
    iterator: AsyncIterator<unknown>,
    first: IteratorResult<unknown>,
    itemSchema: SchemaLike,
    status: number,
    format: 'sse' | 'jsonl',
  ): Response {
    const framer: StreamFramer = format === 'jsonl' ? JSONL_FRAMER : SSE_FRAMER;
    const enqueue = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      text: string,
    ) => controller.enqueue(STREAM_ENCODER.encode(text));

    // Returns true if the item passed validation and was written; on failure it
    // writes a terminal error frame and returns false (caller stops iterating).
    const writeItem = (
      controller: ReadableStreamDefaultController<Uint8Array>,
      item: unknown,
    ): boolean => {
      const parsed = standardParse(itemSchema, item);
      if (!parsed.success) {
        log.debug('stream item failed validation: %j', parsed.issues);
        enqueue(
          controller,
          framer.error({
            statusCode: 500,
            code: ErrorCodes.INTERNAL_ERROR,
            message: 'Stream item failed response validation.',
            details: parsed.issues,
          }),
        );
        return false;
      }
      enqueue(controller, framer.item(parsed.data));
      return true;
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Post-flush discipline: nothing here throws out — the response is
        // already committed, so a mid-stream failure becomes a terminal error
        // frame, mirroring sendStream's catch.
        try {
          if (!first.done) {
            if (!writeItem(controller, first.value)) return;
          }
          while (true) {
            const {value, done} = await iterator.next();
            if (done) break;
            if (!writeItem(controller, value)) break;
          }
        } catch (err) {
          const e = err as Error;
          log.debug('stream handler threw mid-stream: %s', e.message);
          const {issues, ...envelope} = buildErrorEnvelope(err);
          enqueue(
            controller,
            framer.error({
              statusCode: envelope.statusCode ?? 500,
              ...envelope,
              ...(issues ? {issues, details: issues} : {}),
            }),
          );
        } finally {
          controller.close();
        }
      },
      // Client disconnect: stop iterating and let the generator's `finally`
      // blocks release upstream resources.
      cancel() {
        void iterator.return?.();
      },
    });

    return new Response(stream, {status, headers: framer.headers});
  }

  /**
   * Default: JSON with the success status; `status === 204` (or an `undefined`
   * result) returns an empty body. Mirrors {@link RestServer.sendResult}.
   */
  private toResultResponse(result: unknown, status: number): Response {
    if (status === 204 || result === undefined) {
      return new Response(null, {status});
    }
    return Response.json(result as object, {status});
  }

  /**
   * Mirror {@link RestServer.sendError} byte-for-byte: a machine-actionable
   * envelope wrapped under `{error: …}`, status from the envelope's
   * `statusCode` (default 500), with `details` kept alongside `issues` as the
   * historical alias.
   */
  private toErrorResponse(err: unknown): Response {
    const envelope = buildErrorEnvelope(err);
    const {issues, ...rest} = envelope;
    return Response.json(
      {
        error: {
          ...rest,
          ...(issues ? {issues, details: issues} : {}),
        },
      },
      {status: envelope.statusCode ?? 500},
    );
  }

  /**
   * Run the `@authenticate` strategy declared on the route, if any — the Web
   * mirror of {@link RestServer.authenticate}. Reuses the SAME
   * `getAuthenticationMetadata` / `resolveStrategy` / `normalizeAuthResult`
   * helpers and the SAME 401/500 status mapping, feeding the strategy the
   * neutral {@link fromWebRequest} adapter so one strategy contract serves both
   * surfaces.
   */
  private async authenticate(
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
        await strategy.authenticate(fromWebRequest(req), meta.options),
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
   * Apply `@authorize` metadata for the route — the Web mirror of
   * {@link RestServer.authorize}. Runs voters against the per-request context so
   * request-scoped bindings (the principal bound above, tenant, client app) are
   * visible; throws 403 on a non-ALLOW decision.
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
}
