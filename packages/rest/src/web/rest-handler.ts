// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Context, resolveInjectedArguments} from '@agentback/context';
import {CoreTags} from '@agentback/core';
import {
  buildErrorEnvelope,
  standardParse,
  type RouteSchemas,
} from '@agentback/openapi';
import {loggers} from '@agentback/common';
import {RestBindings} from '../keys.js';
import {invalidRequestBody} from '../errors.js';
import {parseSection} from '../validate-sections.js';
import type {Dispatch} from './dispatch.js';
import type {RouteMatch} from './router.js';
import type {RouteValue} from './route-value.js';

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
 * drive it directly. Auth, dispatch hooks, idempotency, confirmation,
 * streaming, and uploads are deferred — this is the core happy path + errors.
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
    reqCtx.bind(RestBindings.HTTP_REQUEST).to(req as never);

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

  private async resolveController<T>(ctor: Function): Promise<T> {
    for (const binding of this.context.findByTag(CoreTags.CONTROLLER)) {
      if ((binding.valueConstructor as unknown) === ctor) {
        return this.context.get<T>(binding.key);
      }
    }
    if (this.context.contains(`controllers.${ctor.name}`)) {
      return this.context.get<T>(`controllers.${ctor.name}`);
    }
    throw new Error(
      `Controller ${ctor.name} is not bound. Use app.controller(${ctor.name}).`,
    );
  }
}
