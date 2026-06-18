// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {JsonSchema} from '../api';
import {propType} from './schema';

/**
 * Coerce a raw form value into the typed JSON the tool expects, based on the
 * field's JSON-Schema type. An empty string becomes `undefined` so the server's
 * Zod schema reports the field as missing rather than as an empty value.
 */
export function coerceValue(
  raw: string | boolean,
  schema: JsonSchema,
): unknown {
  if (typeof raw === 'boolean') return raw;
  if (raw === '') return undefined;
  switch (propType(schema)) {
    case 'integer':
    case 'number': {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    case 'boolean':
      return raw === 'true';
    case 'object':
    case 'array':
      try {
        return JSON.parse(raw);
      } catch {
        return raw; // let the server surface the validation error
      }
    case 'string':
    case 'enum':
      return raw;
    default:
      // Unknown/mixed schema: try JSON, fall back to the raw string.
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
  }
}
