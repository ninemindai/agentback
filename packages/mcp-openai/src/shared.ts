// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Icon} from '@modelcontextprotocol/server';
import {loggers} from '@agentback/common';
import {standardParse, type SchemaLike} from '@agentback/openapi';

const log = loggers('agentback:mcp-openai');

/** Log a warning under `agentback:mcp-openai:warn`. */
export function warn(format: string, ...args: unknown[]): void {
  log.warn(format, ...args);
}

/** `_meta` key for OpenAI's tool UI metadata (entrypoints, display modes). */
export const OPENAI_UI_META_KEY = 'openai/ui';
/** `_meta` key for OpenAI's tool extension markers (`mentions/search`). */
export const OPENAI_EXTENSIONS_META_KEY = 'openai/extensions';
/** Request `_meta` key ChatGPT sets on a file-entrypoint tool call. */
export const OPENAI_RESOURCE_META_KEY = 'openai/resource';
/** Capability id for structured settings. */
export const OPENAI_SETTINGS_CAPABILITY = 'openai/settings';

export function nonBlank(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/\S/.test(value)) {
    throw new Error(`${what} must be a non-blank string`);
  }
  return value;
}

/** True when `schema` (if any) accepts `sample`. No schema accepts anything. */
export function accepts(
  schema: SchemaLike | undefined,
  sample: unknown,
): boolean {
  if (!schema) return true;
  try {
    return standardParse(schema, sample).success;
  } catch {
    // An async-only schema cannot be checked at decoration; let it through.
    return true;
  }
}

/** An image an OpenAI surface renders: an https URL or a data URI. */
export function assertImageIcon(icon: Icon | undefined, what: string): void {
  if (icon === undefined) return;
  const src = (icon as {src?: unknown}).src;
  if (
    typeof src !== 'string' ||
    !(src.startsWith('https://') || src.startsWith('data:image/'))
  ) {
    throw new Error(`${what}.src must be an https URL or a data:image/ URI`);
  }
}
