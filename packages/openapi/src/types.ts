// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  PathsObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SchemaObject,
  SchemasObject,
  ComponentsObject,
  ServerObject,
  ContentObject,
  MediaTypeObject,
  TagObject,
  SecurityRequirementObject,
  ExternalDocumentationObject,
} from 'openapi3-ts/oas31';

export {
  OpenAPIObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  PathsObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
  ResponsesObject,
  SchemaObject,
  SchemasObject,
  ComponentsObject,
  ServerObject,
  ContentObject,
  MediaTypeObject,
  TagObject,
  SecurityRequirementObject,
  ExternalDocumentationObject,
};

export type OpenApiSpec = OpenAPIObject;

export type HttpVerb =
  | 'get'
  | 'post'
  | 'put'
  | 'patch'
  | 'delete'
  | 'head'
  | 'options';

export function isReferenceObject(
  obj: SchemaObject | ReferenceObject | undefined,
): obj is ReferenceObject {
  return !!obj && '$ref' in obj;
}

export function isSchemaObject(
  obj: SchemaObject | ReferenceObject | undefined,
): obj is SchemaObject {
  return !!obj && !('$ref' in obj);
}

export const DEFAULT_OPENAPI_SPEC_INFO = {
  title: 'LoopBack Application',
  version: '1.0.0',
};

export function createEmptyApiSpec(): OpenApiSpec {
  const spec = {
    openapi: '3.1.1',
    info: {...DEFAULT_OPENAPI_SPEC_INFO},
    paths: {},
    servers: [{url: '/'}],
  } as OpenApiSpec;
  // jsonSchemaDialect is a valid OpenAPI 3.1 field but isn't typed in
  // openapi3-ts v4. Attach via cast.
  (spec as unknown as Record<string, unknown>).jsonSchemaDialect =
    'https://spec.openapis.org/oas/3.1/dialect/base';
  return spec;
}
