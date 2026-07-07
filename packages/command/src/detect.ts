// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {OutputFormat} from './serialize.js';

/**
 * Default output format from the stdout TTY only (eng review T5 / outside voice
 * finding 8). Deliberately does NOT sniff `CI`/`CLAUDECODE`/`CURSOR_*`: `CI` is
 * set in every pipeline, so sniffing it would silently flip the format inside
 * the app's own tests. A human at a terminal gets `text`; a piped/redirected
 * caller (script, agent) gets machine-readable `json`. Override explicitly with
 * `--format`.
 */
export function detectFormat(): OutputFormat {
  return process.stdout.isTTY ? 'text' : 'json';
}
