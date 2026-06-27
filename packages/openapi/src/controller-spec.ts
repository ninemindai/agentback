// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MetadataAccessor, MetadataInspector} from '@agentback/metadata';
import {loggers} from '@agentback/common';
import {OAI3Keys, RestEndpoint} from './keys.js';
import type {
  ComponentsObject,
  OpenApiSpec,
  OperationObject,
  ParameterObject,
  PathItemObject,
  PathsObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SchemasObject,
} from './types.js';
import {createEmptyApiSpec} from './types.js';
import {
  isOptionalSchema,
  schemaPropertyInfo,
  schemaToOpenApiSchema,
  type SchemaLike,
} from './zod-bridge.js';
import type {RouteOptions} from './decorators/operation.decorator.js';

const log = loggers('agentback:openapi:controller-spec');

/**
 * Loose-coupled accessors for `@authenticate` metadata produced by
 * `@agentback/authentication`. We avoid importing the auth package so
 * openapi has no runtime dep on it; the metadata keys are stable strings.
 */
const AUTH_METHOD_KEY = MetadataAccessor.create<
  {strategy: string; options?: Record<string, unknown>; skip?: boolean},
  MethodDecorator
>('authentication:method');
const AUTH_CLASS_KEY = MetadataAccessor.create<
  {strategy: string; options?: Record<string, unknown>; skip?: boolean},
  ClassDecorator
>('authentication:class');

function authMetaFor(
  ctor: Function,
  methodName: string,
): {strategy: string; skip?: boolean} | undefined {
  return (
    MetadataInspector.getMethodMetadata(
      AUTH_METHOD_KEY,
      ctor.prototype,
      methodName,
    ) ?? MetadataInspector.getClassMetadata(AUTH_CLASS_KEY, ctor)
  );
}

export interface ControllerSpec {
  basePath?: string;
  name?: string;
  paths?: PathsObject;
  components?: ComponentsObject;
  tags?: string[];
  description?: string;
}

/** Emit one OpenAPI `parameters[]` entry per key of an object schema. */
function paramsFromObject(
  obj: SchemaLike,
  location: 'path' | 'query' | 'header',
): ParameterObject[] {
  const out: ParameterObject[] = [];
  const {keys, required, properties} = schemaPropertyInfo(obj);
  for (const name of keys) {
    out.push({
      name,
      in: location,
      required: location === 'path' ? true : required.has(name),
      schema: properties[name],
    });
  }
  return out;
}

/** Translate `RouteOptions` to an OpenAPI OperationObject. */
function operationFromOptions(
  operationId: string,
  options: RouteOptions,
): OperationObject {
  const operation: OperationObject = {
    operationId,
    responses: {} as ResponsesObject,
  };

  if (options.summary) operation.summary = options.summary;
  if (options.description) operation.description = options.description;
  if (options.tags?.length) operation.tags = options.tags;

  const parameters: ParameterObject[] = [];
  if (options.path) parameters.push(...paramsFromObject(options.path, 'path'));
  if (options.query)
    parameters.push(...paramsFromObject(options.query, 'query'));
  if (options.headers)
    parameters.push(...paramsFromObject(options.headers, 'header'));
  if (options.confirm) {
    parameters.push({
      name: 'x-confirmation-token',
      in: 'header',
      required: false,
      description:
        'Confirmation token for this dangerous operation. Call once ' +
        'without it to receive a single-use token in a 409 ' +
        '`confirmation_required` error, then retry the identical request ' +
        'with the token in this header.',
      schema: {type: 'string'},
    });
    (operation as Record<string, unknown>)['x-confirmation-required'] = true;
  }
  if (options.idempotency) {
    const required =
      typeof options.idempotency === 'object' &&
      options.idempotency.required === true;
    parameters.push({
      name: 'idempotency-key',
      in: 'header',
      required,
      description:
        'Unique key deduplicating this mutation: replaying the same key ' +
        'returns the original result without re-executing the operation.',
      schema: {type: 'string'},
    });
  }
  if (parameters.length) operation.parameters = parameters;

  if (options.body) {
    const bodySchema = schemaToOpenApiSchema(options.body);
    // A `fileField()` emits `format: binary` (via Zod meta); its presence flips
    // the request body to multipart/form-data. Otherwise it's JSON.
    const mediaType = hasBinaryProperty(bodySchema)
      ? 'multipart/form-data'
      : 'application/json';
    const requestBody: RequestBodyObject = {
      required: !isOptionalSchema(options.body),
      content: {
        [mediaType]: {
          schema: bodySchema,
        },
      },
    };
    operation.requestBody = requestBody;
  }

  const status = options.status ?? 200;
  if (options.response) {
    (operation.responses as ResponsesObject)[String(status)] = {
      description: 'Success',
      content: {
        'application/json': {
          schema: schemaToOpenApiSchema(options.response),
        },
      },
    } as ResponseObject;
  }
  if (options.streamOf) {
    // OpenAPI 3.2's `itemSchema`, extension-prefixed while the emitted
    // document version is 3.1.x (bare `itemSchema` is invalid in a 3.1
    // Media Type Object under strict validators). The promotion pass
    // (`promoteItemSchemas`) walks every media type, so the jsonl media
    // type is promoted the same way the SSE one is.
    const jsonl = options.format === 'jsonl';
    const mediaType = jsonl ? 'application/jsonl' : 'text/event-stream';
    (operation.responses as ResponsesObject)[String(status)] = {
      description: jsonl
        ? 'Newline-delimited JSON stream'
        : 'Server-sent event stream',
      content: {
        [mediaType]: {
          'x-itemSchema': schemaToOpenApiSchema(options.streamOf),
        },
      },
    } as unknown as ResponseObject;
  }
  if (options.responses) {
    for (const [code, entry] of Object.entries(options.responses)) {
      if (!entry) continue;
      const responseObj: ResponseObject = {
        description: entry.description ?? '',
        ...(entry.schema
          ? {
              content: {
                'application/json': {
                  schema: schemaToOpenApiSchema(entry.schema),
                },
              },
            }
          : {}),
      };
      (operation.responses as ResponsesObject)[String(code)] = responseObj;
    }
  }
  if (Object.keys(operation.responses as ResponsesObject).length === 0) {
    (operation.responses as ResponsesObject).default = {
      description: 'No content',
    };
  }

  return operation;
}

/**
 * Compute the OpenAPI controller spec for a single controller class.
 * Walks class-level `@api` + method-level `@get`/`@post`/... metadata.
 * Parameters/requestBody/responses are built from each route's
 * `RouteOptions` (declared on the verb decorator).
 */
export function resolveControllerSpec(constructor: Function): ControllerSpec {
  log.debug('Resolving controller spec for %s', constructor.name);

  const classMeta = MetadataInspector.getClassMetadata<ControllerSpec>(
    OAI3Keys.CLASS_KEY,
    constructor,
  );
  const spec: ControllerSpec = {
    name: constructor.name,
    basePath: classMeta?.basePath ?? '',
    paths: {},
    components: {schemas: {}},
    tags: classMeta?.tags,
    description: classMeta?.description,
  };

  const methods = MetadataInspector.getAllMethodMetadata<RestEndpoint>(
    OAI3Keys.METHODS_KEY,
    constructor.prototype,
  );
  if (!methods) {
    log.debug('  no @get/@post/... methods on %s', constructor.name);
    return spec;
  }

  for (const [methodName, endpoint] of Object.entries(methods)) {
    const {verb, path, options} = endpoint;
    const operationId = `${constructor.name}.${methodName}`;
    const operation = operationFromOptions(operationId, options);

    // If @authenticate(strategy) is present (method or class level), advertise
    // the security requirement as `<strategy>Auth` so Swagger UI's Authorize
    // button can prompt for credentials. The matching securityScheme must be
    // contributed separately (e.g. by JWTAuthenticationComponent).
    const auth = authMetaFor(constructor, methodName);
    if (auth && !auth.skip && !operation.security) {
      operation.security = [{[`${auth.strategy}Auth`]: []}];
    }

    const paths = spec.paths as PathsObject;
    const pathItem = (paths[path] ?? {}) as PathItemObject;
    (pathItem as Record<string, unknown>)[verb] = operation;
    paths[path] = pathItem;
  }

  return spec;
}

/**
 * Memoized accessor: returns the same spec object across calls.
 */
export function getControllerSpec(constructor: Function): ControllerSpec {
  let spec = MetadataInspector.getClassMetadata<ControllerSpec>(
    OAI3Keys.CONTROLLER_SPEC_KEY,
    constructor,
    {ownMetadataOnly: true},
  );
  if (!spec) {
    spec = resolveControllerSpec(constructor);
    MetadataInspector.defineMetadata(
      OAI3Keys.CONTROLLER_SPEC_KEY.key,
      spec,
      constructor,
    );
  }
  return spec;
}

/**
 * Merge controller specs into a top-level OpenAPI document.
 */
export function assembleOpenApiSpec(
  controllers: Function[],
  base?: Partial<OpenApiSpec>,
): OpenApiSpec {
  const doc = {...createEmptyApiSpec(), ...base};
  const schemas = {
    ...(doc.components?.schemas ?? {}),
  } as Record<string, unknown>;

  for (const ctor of controllers) {
    const ctrl = getControllerSpec(ctor);
    const prefix = ctrl.basePath ?? '';
    for (const [path, item] of Object.entries(ctrl.paths ?? {})) {
      const full = collapseSlashes(prefix + path);
      doc.paths = doc.paths ?? {};
      doc.paths[full] = {
        ...((doc.paths[full] as PathItemObject) ?? {}),
        ...(item as PathItemObject),
      };
    }
    Object.assign(schemas, ctrl.components?.schemas ?? {});
  }

  doc.components = {
    ...(doc.components ?? {}),
    schemas: schemas as SchemasObject,
  };

  // Stream routes emit `x-itemSchema` (extension-prefixed) because bare
  // `itemSchema` is invalid in a 3.1 Media Type Object. When the document
  // declares OpenAPI >= 3.2 (e.g. via `openApiSpec.overrides.openapi`),
  // promote it to the real 3.2 keyword.
  if (isOpenApi32OrLater(doc.openapi)) promoteItemSchemas(doc);
  return doc;
}

/**
 * Collapse runs of `/` in a joined route path. Joining a `basePath` and a route
 * path by concatenation yields `//hello` when the basePath is `'/'` (mount at
 * root) or ends in a slash; this normalizes it back to a single separator so
 * the OpenAPI path key and the mounted route agree (`/hello`).
 */
export function collapseSlashes(path: string): string {
  return path.replace(/\/{2,}/g, '/');
}

/** True for '3.2.0' and later 3.x minors (string-compared, no semver dep). */
function isOpenApi32OrLater(version: string | undefined): boolean {
  if (!version) return false;
  const [major, minor] = version.split('.').map(Number);
  return major === 3 && minor >= 2;
}

/** Rename `x-itemSchema` → `itemSchema` across every media type object. */
function promoteItemSchemas(doc: OpenApiSpec): void {
  for (const item of Object.values(doc.paths ?? {})) {
    for (const op of Object.values(item as Record<string, unknown>)) {
      if (!op || typeof op !== 'object') continue;
      const responses = (op as {responses?: Record<string, unknown>}).responses;
      for (const response of Object.values(responses ?? {})) {
        const content = (response as {content?: Record<string, unknown>})
          ?.content;
        for (const media of Object.values(content ?? {})) {
          const m = media as Record<string, unknown>;
          if ('x-itemSchema' in m) {
            m.itemSchema = m['x-itemSchema'];
            delete m['x-itemSchema'];
          }
        }
      }
    }
  }
}

/**
 * Walk an emitted OpenAPI schema for any `format: 'binary'` property (produced
 * by {@link fileField}). Its presence marks the request body as
 * `multipart/form-data` rather than `application/json`.
 */
function hasBinaryProperty(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const s = schema as {
    format?: string;
    properties?: Record<string, unknown>;
    items?: unknown;
  };
  if (s.format === 'binary') return true;
  if (s.properties) return Object.values(s.properties).some(hasBinaryProperty);
  if (s.items) return hasBinaryProperty(s.items);
  return false;
}
