// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import createError from 'http-errors';
import {
  ErrorCodes,
  schemaToOpenApiSchema,
  type SchemaLike,
} from '@agentback/openapi';
import type {ZodError} from 'zod';

export interface ValidationIssue {
  path: (string | number)[];
  /** Issue code — present for Zod schemas; other vendors may omit it. */
  code?: string;
  message: string;
  expected?: string;
  received?: string;
}

/** Extra agent-contract fields the REST error constructors attach. */
interface AgentErrorFields {
  code: string;
  details: ValidationIssue[];
  /** JSON Schema of the violated input section, when derivable. */
  schema?: unknown;
}

export function zodIssuesToDetails(err: ZodError): ValidationIssue[] {
  return err.issues.map(i => ({
    path: i.path as (string | number)[],
    code: i.code,
    message: i.message,
    expected: (i as {expected?: string}).expected,
    received: (i as {received?: string}).received,
  }));
}

/**
 * Best-effort JSON Schema of the violated section, attached to validation
 * errors so an agent can re-shape its input without a second round-trip to
 * /openapi.json. Emission failures (a Standard Schema vendor without a
 * converter) degrade to omitting the field — the issues still carry
 * `expected`/`received`.
 */
function violatedSchema(schema?: SchemaLike): unknown {
  if (!schema) return undefined;
  try {
    return schemaToOpenApiSchema(schema);
  } catch {
    return undefined;
  }
}

/**
 * 422 Unprocessable Entity — request body failed validation. Carries the
 * stable code `invalid_body`, the per-field issues, and (when derivable)
 * the body schema itself.
 */
export function invalidRequestBody(
  details: ValidationIssue[],
  schema?: SchemaLike,
) {
  const e = createError(422, 'The request body is invalid.');
  const agentErr = e as createError.HttpError & AgentErrorFields;
  agentErr.code = ErrorCodes.INVALID_BODY;
  agentErr.details = details;
  agentErr.schema = violatedSchema(schema);
  return e;
}

/**
 * 400 Bad Request — parameter (path/query/header/cookie) failed validation.
 * Carries the stable code `invalid_parameter`, the per-field issues, and
 * (when derivable) the violated section's schema.
 */
export function invalidParameter(
  name: string,
  details: ValidationIssue[],
  schema?: SchemaLike,
) {
  const e = createError(400, `Invalid value for parameter '${name}'.`);
  const agentErr = e as createError.HttpError & AgentErrorFields;
  agentErr.code = ErrorCodes.INVALID_PARAMETER;
  agentErr.details = details;
  agentErr.schema = violatedSchema(schema);
  return e;
}
