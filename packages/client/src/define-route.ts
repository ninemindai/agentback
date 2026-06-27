// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ZodType, z} from 'zod';
import type {Client} from './client.js';
import {ClientError} from './errors.js';
import {parseNDJSON} from './ndjson.js';
import {parseSSE, type SSEEvent} from './sse.js';
import {isStandardSchema, type StandardSchemaV1} from './standard-schema.js';
import {encodeQuery, expandPath, joinUrl} from './url.js';

/**
 * Any schema a route slot accepts: Zod, or any Standard Schema V1 vendor
 * (`~standard`). Mirrors the server's `SchemaLike`.
 */
export type SchemaLike = ZodType | StandardSchemaV1;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/**
 * Mirrors the shape the server-side `@verb` decorator records. Duplicated
 * here (rather than imported from @agentback/openapi) so the client
 * stays a pure schema-consumer with no server-side dependency — important
 * for browser bundle size and for using the client against any
 * OpenAPI/Zod-shaped server.
 */
export interface RouteSchemas {
  body?: SchemaLike;
  path?: SchemaLike;
  query?: SchemaLike;
  headers?: SchemaLike;
  response?: SchemaLike;
  /**
   * Per-item schema for a stream route (the server's `streamOf:`).
   * Consumed via `route.stream(client, input)`.
   */
  streamOf?: SchemaLike;
  /**
   * Wire format for a `streamOf` route: `'sse'` (default) consumes a
   * `text/event-stream` body; `'jsonl'` consumes newline-delimited JSON
   * (`application/jsonl`). Must match the server's `format:` declaration.
   */
  format?: 'sse' | 'jsonl';
  /**
   * Per-status response schemas. When a non-2xx status comes back, the
   * matching schema (if any) is used to parse the body; the parsed value
   * is attached to `ClientError.parsedBody`. Field name matches the
   * server's `RouteSchemas.responses` so the same schemas can be shared.
   */
  responses?: Record<number, SchemaLike>;
}

type InferZ<T> = T extends ZodType
  ? z.infer<T>
  : T extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<T>
    : never;

type ParseOk = {success: true; data: unknown};
type ParseFail = {success: false; issues: {message: string}[]};

/** Synchronous validation across Zod and Standard Schema vendors. */
function standardParse(
  schema: SchemaLike,
  value: unknown,
): ParseOk | ParseFail {
  if (
    typeof (schema as ZodType).safeParse === 'function' &&
    !isStandardSchemaOnly(schema)
  ) {
    const parsed = (schema as ZodType).safeParse(value);
    return parsed.success
      ? {success: true, data: parsed.data}
      : {success: false, issues: parsed.error.issues};
  }
  const result = (schema as StandardSchemaV1)['~standard'].validate(value);
  if (result instanceof Promise) {
    throw new ClientError(
      'Async validation is not supported on route schemas.',
      0,
      undefined,
    );
  }
  return result.issues == null
    ? {success: true, data: result.value}
    : {success: false, issues: result.issues as {message: string}[]};
}

/** True for non-Zod standard schemas (no usable safeParse). */
function isStandardSchemaOnly(schema: SchemaLike): boolean {
  return (
    isStandardSchema(schema) &&
    typeof (schema as Partial<ZodType>).safeParse !== 'function'
  );
}

/**
 * Conditional input shape: only includes keys whose schemas are declared.
 * Mirrors the server's `{body, path, query, headers}` bundle exactly.
 */
export type RouteInput<S extends RouteSchemas> = (S extends {path: SchemaLike}
  ? {path: InferZ<S['path']>}
  : {}) &
  (S extends {query: SchemaLike} ? {query: InferZ<S['query']>} : {}) &
  (S extends {headers: SchemaLike} ? {headers: InferZ<S['headers']>} : {}) &
  (S extends {body: SchemaLike} ? {body: InferZ<S['body']>} : {});

export type RouteOutput<S extends RouteSchemas> = S extends {
  response: SchemaLike;
}
  ? InferZ<S['response']>
  : unknown;

/** The per-item type of a stream route. */
export type StreamItem<S extends RouteSchemas> = S extends {
  streamOf: SchemaLike;
}
  ? InferZ<S['streamOf']>
  : unknown;

/**
 * Discriminated result, mirroring Zod's `safeParse` shape. Returned by
 * `route.safeCall(...)` so consumers can branch on success/failure without
 * try/catch.
 */
export type Result<T, E = ClientError> =
  | {success: true; data: T}
  | {success: false; error: E};

export interface RouteCallOptions {
  /** Per-call extra headers, merged on top of defaults + schema headers. */
  headers?: Record<string, string>;
  /** AbortSignal forwarded to fetch. Takes precedence over `timeoutMs`. */
  signal?: AbortSignal;
  /**
   * Per-call timeout in milliseconds, overriding the client's default.
   * Implemented via `AbortSignal.timeout`. Ignored when `signal` is set.
   */
  timeoutMs?: number;
}

// When no schemas are declared, RouteInput<S> is `{}` (keyof is `never`).
// In that case allow `.call(client)` without an input argument.
type CallInputArg<S extends RouteSchemas> = keyof RouteInput<S> extends never
  ? void | RouteInput<S>
  : RouteInput<S>;

export interface RouteHandle<S extends RouteSchemas> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly schemas: S;
  /**
   * Compose the full request URL (baseURL + path + querystring), validating
   * the path and query slots. Synchronous — does not resolve client default
   * headers and does not fire a request. Useful for prefetch links, logging,
   * or building <a href> targets.
   */
  url(client: Client, input: CallInputArg<S>): string;
  /**
   * Execute the route. Validates input, fires the request, validates the
   * response. Throws `ClientError` on any failure.
   */
  call(
    client: Client,
    input: CallInputArg<S>,
    options?: RouteCallOptions,
  ): Promise<RouteOutput<S>>;
  /**
   * Same as `call` but never throws — returns a discriminated `Result`
   * with either `{success: true, data}` or `{success: false, error}`.
   * Mirrors Zod's `safeParse` so call sites can branch without try/catch.
   */
  safeCall(
    client: Client,
    input: CallInputArg<S>,
    options?: RouteCallOptions,
  ): Promise<Result<RouteOutput<S>>>;
  /**
   * Consume an SSE stream route (`streamOf:` on the server). Validates input
   * slots, fires the request with `Accept: text/event-stream`, and yields
   * each event's payload validated against `schemas.streamOf`. `event: error`
   * frames and validation mismatches throw `ClientError`. Abort via
   * `options.signal`.
   */
  stream(
    client: Client,
    input: CallInputArg<S>,
    options?: RouteCallOptions,
  ): AsyncGenerator<StreamItem<S>, void, unknown>;
}

/**
 * Define a typed remote route. The returned handle carries the schemas and
 * exposes `.call(client, input)` to execute the request against any
 * `createClient(...)` instance. Validation runs on every slot the schemas
 * declare; mismatches throw `ClientError` with `status === 0` before any
 * network call.
 */
export function defineRoute<S extends RouteSchemas>(
  method: HttpMethod,
  path: string,
  schemas: S,
): RouteHandle<S> {
  const handle: RouteHandle<S> = {
    method,
    path,
    schemas,
    url(client, input) {
      const inputObj = (input ?? {}) as Record<string, unknown>;
      const pathParams = schemas.path
        ? (validate('path', schemas.path, inputObj.path ?? {}) as Record<
            string,
            unknown
          >)
        : undefined;
      const queryParams = schemas.query
        ? (validate('query', schemas.query, inputObj.query ?? {}) as Record<
            string,
            unknown
          >)
        : undefined;
      return (
        joinUrl(client.baseURL, expandPath(path, pathParams)) +
        encodeQuery(queryParams)
      );
    },
    async safeCall(client, input, options) {
      try {
        const data = await executeRoute<S>(
          handle,
          client,
          input as Record<string, unknown> | undefined,
          options,
        );
        return {success: true, data};
      } catch (err) {
        const error =
          err instanceof ClientError
            ? err
            : new ClientError(
                `Unexpected error: ${(err as Error).message}`,
                0,
                undefined,
              );
        return {success: false, error};
      }
    },
    async call(client, input, options) {
      return executeRoute<S>(
        handle,
        client,
        input as Record<string, unknown> | undefined,
        options,
      );
    },
    async *stream(client, input, options) {
      const {method, schemas} = handle;
      const jsonl = schemas.format === 'jsonl';
      const req = await prepareRequest(
        handle,
        client,
        input as Record<string, unknown> | undefined,
        options,
      );
      req.headers['accept'] = jsonl ? 'application/jsonl' : 'text/event-stream';

      let response: Response;
      try {
        response = await client.fetch(req.url, {
          method,
          headers: req.headers,
          body: req.body,
          signal: req.signal,
        });
      } catch (err) {
        const e = err as Error & {name?: string};
        const isAbort = e.name === 'AbortError' || e.name === 'TimeoutError';
        const prefix = isAbort
          ? `Request aborted calling ${method} ${req.url}`
          : `Network error calling ${method} ${req.url}`;
        throw new ClientError(`${prefix}: ${e.message}`, 0, undefined);
      }

      if (!response.ok) {
        const text = await response.text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
        const message =
          (body as {error?: {message?: string}} | undefined)?.error?.message ??
          `${method} ${req.url} failed with ${response.status}`;
        throw new ClientError(message, response.status, body, response);
      }
      if (!response.body) {
        throw new ClientError(
          `${method} ${req.url}: response has no body to stream`,
          response.status,
          undefined,
          response,
        );
      }

      // Both formats emit the same per-item JSON. A frame can be a normal item
      // or a terminal error record `{"error":{...}}`; SSE additionally tags
      // errors with `event: error`. `decodeFrame` reduces each transport's
      // frame to `{item, isError}`, after which validation + yield is shared.
      const frames = jsonl
        ? mapNDJSON(parseNDJSON(response.body))
        : mapSSE(parseSSE(response.body));

      for await (const {item, isError} of frames) {
        if (isError) {
          const message =
            (item as {error?: {message?: string}} | undefined)?.error
              ?.message ?? 'Stream error';
          throw new ClientError(message, response.status, item, response);
        }
        if (schemas.streamOf) {
          const parsed = standardParse(schemas.streamOf, item);
          if (!parsed.success) {
            throw new ClientError(
              `Stream item failed validation: ${issuesToMessage(
                parsed.issues,
              )}`,
              response.status,
              item,
              response,
            );
          }
          yield parsed.data as StreamItem<S>;
        } else {
          yield item as StreamItem<S>;
        }
      }
    },
  };
  return handle;
}

/** A prepared request: validated, serialized, and addressed. */
interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  signal: AbortSignal | undefined;
}

/**
 * Steps 1–3 of route execution (validate input slots, assemble URL, merge
 * headers) — shared by `call`/`safeCall` and `stream`.
 */
async function prepareRequest<S extends RouteSchemas>(
  handle: RouteHandle<S>,
  client: Client,
  input: Record<string, unknown> | undefined,
  options: RouteCallOptions | undefined,
): Promise<PreparedRequest> {
  const {schemas} = handle;
  const inputObj = input ?? {};

  const pathParams = schemas.path
    ? (validate('path', schemas.path, inputObj.path ?? {}) as Record<
        string,
        unknown
      >)
    : undefined;

  const queryParams = schemas.query
    ? (validate('query', schemas.query, inputObj.query ?? {}) as Record<
        string,
        unknown
      >)
    : undefined;

  let validatedHeaders: Record<string, string> | undefined;
  if (schemas.headers) {
    // Server lowercases incoming header names before validation; mirror
    // that here so the same headers schema works on both sides.
    const raw = (inputObj.headers ?? {}) as Record<string, unknown>;
    const lowered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) lowered[k.toLowerCase()] = v;
    const parsed = validate('headers', schemas.headers, lowered) as Record<
      string,
      unknown
    >;
    validatedHeaders = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === undefined || v === null) continue;
      validatedHeaders[k] = String(v);
    }
  }

  let serializedBody: string | undefined;
  if (schemas.body) {
    const parsed = validate('body', schemas.body, inputObj.body);
    serializedBody = JSON.stringify(parsed);
  }

  const url =
    joinUrl(client.baseURL, expandPath(handle.path, pathParams)) +
    encodeQuery(queryParams);

  const defaults = await client.resolveHeaders();
  const headers: Record<string, string> = {
    ...defaults,
    ...(validatedHeaders ?? {}),
    ...(options?.headers ?? {}),
  };
  if (serializedBody !== undefined && !hasContentType(headers)) {
    headers['content-type'] = 'application/json';
  }

  return {
    url,
    headers,
    body: serializedBody,
    signal: resolveSignal(client, options),
  };
}

/**
 * The single execution path shared by `call` and `safeCall`. Validates
 * input, builds the request, parses the response, and validates output.
 * Throws `ClientError` on every failure mode.
 */
async function executeRoute<S extends RouteSchemas>(
  handle: RouteHandle<S>,
  client: Client,
  input: Record<string, unknown> | undefined,
  options: RouteCallOptions | undefined,
): Promise<RouteOutput<S>> {
  const {method, schemas} = handle;

  // ----- 1–3. Validate input slots, assemble URL, merge headers -----
  const req = await prepareRequest(handle, client, input, options);
  const url = req.url;

  // ----- 4. Fire -----
  let response: Response;
  try {
    response = await client.fetch(url, {
      method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
    });
  } catch (err) {
    const e = err as Error & {name?: string};
    const isAbort = e.name === 'AbortError' || e.name === 'TimeoutError';
    const prefix = isAbort
      ? `Request aborted calling ${method} ${url}`
      : `Network error calling ${method} ${url}`;
    throw new ClientError(`${prefix}: ${e.message}`, 0, undefined);
  }

  // ----- 5. Parse response -----
  const text = await response.text();
  let body: unknown = undefined;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    const message =
      (body as {error?: {message?: string}} | undefined)?.error?.message ??
      `${method} ${url} failed with ${response.status}`;
    // If the route declared a schema for this status, surface a typed body.
    const errSchema = schemas.responses?.[response.status];
    const parsedBody = errSchema ? standardParse(errSchema, body) : undefined;
    throw new ClientError(message, response.status, body, response, {
      parsedBody: parsedBody?.success ? parsedBody.data : undefined,
    });
  }

  if (schemas.response) {
    const parsed = standardParse(schemas.response, body);
    if (!parsed.success) {
      throw new ClientError(
        `Response failed validation: ${issuesToMessage(parsed.issues)}`,
        response.status,
        body,
        response,
      );
    }
    return parsed.data as RouteOutput<S>;
  }
  return body as RouteOutput<S>;
}

/** A transport-decoded stream frame: the parsed payload + an error flag. */
interface StreamFrame {
  item: unknown;
  isError: boolean;
}

/** Best-effort JSON parse: returns the raw string when not valid JSON. */
function parseJSONLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Reduce SSE events to {item, isError}; `event: error` marks the error. */
async function* mapSSE(
  events: AsyncGenerator<SSEEvent, void, unknown>,
): AsyncGenerator<StreamFrame, void, unknown> {
  for await (const evt of events) {
    yield {item: parseJSONLoose(evt.data), isError: evt.event === 'error'};
  }
}

/**
 * Reduce NDJSON lines to {item, isError}. JSONL has no per-frame event tag, so
 * a terminal error is recognized by its shape: an object with an `error` key
 * carrying `{statusCode, message}` (the server's terminal error record).
 */
async function* mapNDJSON(
  lines: AsyncGenerator<string, void, unknown>,
): AsyncGenerator<StreamFrame, void, unknown> {
  for await (const line of lines) {
    const item = parseJSONLoose(line);
    const isError =
      item != null &&
      typeof item === 'object' &&
      typeof (item as {error?: {message?: unknown}}).error === 'object' &&
      (item as {error?: {message?: unknown}}).error != null &&
      typeof (item as {error: {message?: unknown}}).error.message === 'string';
    yield {item, isError};
  }
}

function validate(slot: string, schema: SchemaLike, value: unknown): unknown {
  const parsed = standardParse(schema, value);
  if (parsed.success) return parsed.data;
  throw new ClientError(
    `Invalid ${slot}: ${issuesToMessage(parsed.issues)}`,
    0,
    parsed.issues,
  );
}

function issuesToMessage(issues: readonly {message: string}[]): string {
  return issues.map(i => i.message).join('; ');
}

function hasContentType(headers: Record<string, string>): boolean {
  return Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
}

/**
 * Determine the AbortSignal for the request. Explicit signal wins; then a
 * per-call timeout; then the client's default timeout; otherwise undefined.
 */
function resolveSignal(
  client: Client,
  options: RouteCallOptions | undefined,
): AbortSignal | undefined {
  if (options?.signal) return options.signal;
  const ms = options?.timeoutMs ?? client.defaultTimeoutMs;
  return ms && ms > 0 ? AbortSignal.timeout(ms) : undefined;
}
