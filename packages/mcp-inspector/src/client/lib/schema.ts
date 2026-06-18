// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {JsonSchema} from '../api';

/** Normalize a JSON-Schema `type` (which may be an array like ['string','null'])
 * to a single representative type string. */
export function propType(s: JsonSchema | undefined): string {
  if (!s) return '';
  const t = Array.isArray(s.type) ? s.type.find(x => x !== 'null') : s.type;
  if (t) return t;
  if (s.enum) return 'enum';
  return '';
}

/** Whether `name` is in the parent object schema's `required` list. */
export function isRequired(
  parent: JsonSchema | undefined,
  name: string,
): boolean {
  return !!parent?.required?.includes(name);
}

/** A short human hint describing the type and any constraints. */
export function constraintHint(s: JsonSchema): string {
  const parts: string[] = [];
  const t = propType(s);
  if (t && t !== 'enum') parts.push(t);
  if (s.enum) parts.push('one of ' + s.enum.map(v => String(v)).join(', '));
  if (s.minimum != null || s.maximum != null) {
    parts.push(`${s.minimum ?? ''}–${s.maximum ?? ''}`);
  }
  if (s.minLength != null) parts.push('min ' + s.minLength);
  if (s.maxLength != null) parts.push('max ' + s.maxLength);
  return parts.join(' · ');
}
