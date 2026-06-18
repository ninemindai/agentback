// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  standardParse,
  type ParseIssue,
  type SchemaLike,
} from '@agentback/openapi';
import {invalidParameter} from './errors.js';

/**
 * Validate one request section (path/query/headers) against its Zod schema.
 * Shared by the Express `buildInputBundle` and the Web `RestHandler` so both
 * surfaces enforce identical semantics. Throws `invalidParameter` (400) naming
 * the first offending field.
 */
export function parseSection(
  section: 'path' | 'query' | 'headers',
  raw: Record<string, unknown>,
  schema: SchemaLike,
): Record<string, unknown> {
  const parsed = standardParse(schema, raw);
  if (parsed.success) return parsed.data as Record<string, unknown>;
  const first: ParseIssue | undefined = parsed.issues[0];
  const name = first?.path?.[0]?.toString() ?? section;
  throw invalidParameter(name, parsed.issues, schema);
}
