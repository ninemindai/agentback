// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {extname} from 'node:path';
import {parse as parseJsoncRaw, printParseErrorCode} from 'jsonc-parser';
import type {ParseError} from 'jsonc-parser';
import {parse as parseYaml} from 'yaml';

/** Parse a JSONC string. Trailing commas and `//` / `/* *\/` comments allowed. */
export function parseJsonc<T = unknown>(text: string, filename?: string): T {
  const errors: ParseError[] = [];
  const result = parseJsoncRaw(text, errors, {allowTrailingComma: true});
  if (errors.length > 0) {
    const msgs = errors.map(
      e => `${printParseErrorCode(e.error)} at offset ${e.offset}`,
    );
    const where = filename ? ` in ${filename}` : '';
    throw new Error(`JSONC parse error${where}: ${msgs.join(', ')}`);
  }
  return result as T;
}

/**
 * Pick a parser by file extension and decode `text`.
 *
 * - `.json`, `.jsonc` → JSONC (comments + trailing commas)
 * - `.yaml`, `.yml`   → YAML
 *
 * Unknown extensions are treated as JSONC, which is also valid JSON.
 */
export function parseConfigText<T = unknown>(
  text: string,
  filename: string,
): T {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.yaml':
    case '.yml':
      try {
        return parseYaml(text) as T;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`YAML parse error in ${filename}: ${message}`);
      }
    case '.json':
    case '.jsonc':
    case '':
    default:
      return parseJsonc<T>(text, filename);
  }
}

/** File extensions this package can parse, in preferred lookup order. */
export const SUPPORTED_EXTENSIONS = [
  '.jsonc',
  '.json',
  '.yaml',
  '.yml',
] as const;
