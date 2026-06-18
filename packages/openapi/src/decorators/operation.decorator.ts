// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describeInjectedArguments} from '@agentback/context';
import {MethodDecoratorFactory} from '@agentback/metadata';
import type {ZodType} from 'zod';
import {OAI3Keys, RestEndpoint} from '../keys.js';
import {
  registerRouteSchemas,
  type InferSchema,
  type SchemaLike,
} from '../zod-bridge.js';

/**
 * Options accepted by a verb decorator (`@get`, `@post`, …). Every schema
 * is optional; the route's input bundle is assembled from whichever of
 * `body`/`path`/`query`/`headers` are provided.
 */
export interface RouteOptions {
  /** Request body schema. The validated body is exposed as `input.body`. */
  body?: SchemaLike;
  /**
   * Path parameter schema (object-shaped). Keys must match the URL
   * placeholders in the verb's path string (`/items/{id}` → schema with
   * `id` key). The validated path object is exposed as `input.path`.
   */
  path?: SchemaLike;
  /** Query parameter schema (object-shaped). Exposed as `input.query`. */
  query?: SchemaLike;
  /** Header schema; declare keys lowercase (Express normalizes incoming names). */
  headers?: SchemaLike;
  /** Success-response schema. Drives the return-type constraint and `responses[status]`. */
  response?: SchemaLike;
  /**
   * Per-item schema for a streaming (SSE) route. Mutually exclusive with
   * `response`. The handler must return an `AsyncIterable` (an async
   * generator) of items; each item is validated against this schema and sent
   * as a `text/event-stream` event. Emitted to OpenAPI as `x-itemSchema`
   * (the OpenAPI 3.2 `itemSchema` keyword, extension-prefixed while the
   * document version is 3.1.x).
   */
  streamOf?: SchemaLike;
  /**
   * Wire format for a streaming (`streamOf`) route. `'sse'` (default) emits
   * a `text/event-stream` Server-Sent Events response; `'jsonl'` emits
   * newline-delimited JSON (`application/jsonl`), one item per line. Ignored
   * for non-streaming routes.
   */
  format?: 'sse' | 'jsonl';
  /** Additional documented responses keyed by status code. */
  responses?: Record<number, {schema?: SchemaLike; description?: string}>;
  /** Success status code. Default 200. */
  status?: number;
  /**
   * Mark the operation as dangerous: the first call is refused with a 409
   * `confirmation_required` error carrying a single-use token; retrying the
   * IDENTICAL request with that token in the `x-confirmation-token` header
   * executes it. The token is bound to the exact payload, so a confirmed
   * call cannot differ from the proposed one. `{ttlMs}` overrides the
   * 5-minute token lifetime.
   */
  confirm?: boolean | {ttlMs?: number};
  /**
   * Honor the `idempotency-key` request header: replaying a key returns the
   * original result without re-executing the handler (errors are not
   * cached). `{required: true}` rejects requests without a key (400
   * `idempotency_key_required`); `{ttlMs}` overrides the 24-hour replay
   * window. Mutually exclusive with `streamOf` (a stream cannot replay).
   */
  idempotency?: boolean | {required?: boolean; ttlMs?: number};
  description?: string;
  summary?: string;
  tags?: string[];
}

/** Keys of `RouteOptions` that contribute to the input bundle. */
const INPUT_KEYS = ['body', 'path', 'query', 'headers'] as const;
type InputKey = (typeof INPUT_KEYS)[number];

/** True when the options declare any input-shaping schema. */
function hasInput(options: RouteOptions): boolean {
  return INPUT_KEYS.some(k => options[k] != null);
}

/**
 * Compile-time input bundle: `{body, path, query, headers}` with only the
 * keys that the route options actually declared.
 */
export type RouteInput<O> = {
  [K in keyof O & InputKey]: O[K] extends SchemaLike
    ? InferSchema<O[K]>
    : never;
};

type SuccessReturn<O> = O extends {streamOf: infer S}
  ? S extends SchemaLike
    ? AsyncIterable<InferSchema<S>> | Promise<AsyncIterable<InferSchema<S>>>
    : unknown
  : O extends {response: infer R}
    ? R extends SchemaLike
      ? InferSchema<R> | Promise<InferSchema<R>>
      : unknown
    : unknown;

/**
 * Build the descriptor type for an HTTP verb decorator. When the options
 * declare any input schema, slot 0 of the method is constrained to
 * `RouteInput<O>` and the return type to `SuccessReturn<O>`. Without input
 * schemas, slot 0 is unconstrained — fully `@inject`-driven routes work too.
 */
type RouteDescriptor<O, R> = O extends {body: unknown}
  ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TypedPropertyDescriptor<(input: RouteInput<O>, ...rest: any[]) => R>
  : O extends {path: unknown}
    ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
      TypedPropertyDescriptor<(input: RouteInput<O>, ...rest: any[]) => R>
    : O extends {query: unknown}
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        TypedPropertyDescriptor<(input: RouteInput<O>, ...rest: any[]) => R>
      : O extends {headers: unknown}
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          TypedPropertyDescriptor<(input: RouteInput<O>, ...rest: any[]) => R>
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          TypedPropertyDescriptor<(...args: any[]) => R>;

function makeVerbDecorator(verb: string) {
  return function verbDecorator<O extends RouteOptions>(
    path: string,
    options?: O,
  ): <R extends SuccessReturn<O>>(
    target: object,
    methodName: string | symbol,
    desc: RouteDescriptor<O, R>,
  ) => void {
    const opts = options ?? ({} as O);
    return function decorate(
      target: object,
      methodName: string | symbol,
      descriptor: PropertyDescriptor,
    ) {
      // A stream cannot be replayed from a cache: refuse the combination.
      if (opts.streamOf && opts.idempotency) {
        const className =
          (target as {constructor?: {name: string}}).constructor?.name ??
          'anonymous';
        throw new Error(
          `@${verb}('${path}') on ${className}.${String(methodName)}: ` +
            `'idempotency' and 'streamOf' are mutually exclusive.`,
        );
      }

      // A stream route has exactly one success shape: the item schema.
      if (opts.streamOf && opts.response) {
        const className =
          (target as {constructor?: {name: string}}).constructor?.name ??
          'anonymous';
        throw new Error(
          `@${verb}('${path}') on ${className}.${String(methodName)}: ` +
            `'streamOf' and 'response' are mutually exclusive.`,
        );
      }

      // Slot-0 guard: when an input bundle is present, @inject on slot 0
      // would shadow it. Refuse at decoration time so the error is precise.
      if (hasInput(opts)) {
        const injected = describeInjectedArguments(
          target,
          methodName as string,
        );
        if (injected[0] != null) {
          const className =
            (target as {constructor?: {name: string}}).constructor?.name ??
            'anonymous';
          throw new Error(
            `@${verb}('${path}') on ${className}.${String(methodName)}: ` +
              `slot 0 is reserved for the validated input bundle when any ` +
              `of body/path/query/headers is set. Move @inject(...) to slot 1+.`,
          );
        }
      }

      registerRouteSchemas(target, methodName, {
        body: opts.body,
        path: opts.path,
        query: opts.query,
        headers: opts.headers,
        response: opts.response,
        streamOf: opts.streamOf,
        format: opts.format,
        responses: opts.responses
          ? Object.fromEntries(
              Object.entries(opts.responses)
                .filter(([, v]) => v?.schema != null)
                .map(([k, v]) => [Number(k), v!.schema as SchemaLike]),
            )
          : undefined,
        confirm: opts.confirm,
        idempotency: opts.idempotency,
      });

      const endpoint: RestEndpoint = {
        verb,
        path,
        options: opts,
        target,
        methodName,
      };
      MethodDecoratorFactory.createDecorator<RestEndpoint>(
        OAI3Keys.METHODS_KEY,
        endpoint,
        {decoratorName: `@${verb}`},
      )(target, methodName, descriptor);
    } as ReturnType<typeof verbDecorator<O>>;
  };
}

export const get = makeVerbDecorator('get');
export const post = makeVerbDecorator('post');
export const put = makeVerbDecorator('put');
export const patch = makeVerbDecorator('patch');
export const del = makeVerbDecorator('delete');

/**
 * Lowest-level verb decorator. Useful for verbs not covered by the
 * shorthands (e.g. `options`, `head`).
 */
export function operation<O extends RouteOptions>(
  verb: string,
  path: string,
  options?: O,
) {
  return makeVerbDecorator(verb.toLowerCase())(path, options);
}
