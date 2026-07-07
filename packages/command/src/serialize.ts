// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {buildErrorEnvelope} from '@agentback/openapi';

/**
 * Output formats. `text` for a human at a terminal, `json` for scripts/agents,
 * `toon` for token-thrift (opt-in, optional peer dep). Success output is the
 * tool's **bare** result — never an `{ok, data}` wrapper (eng review C1): the
 * process exit code carries success/failure, so scripts read `$?`.
 */
export type OutputFormat = 'text' | 'json' | 'toon';

export const OUTPUT_FORMATS: readonly OutputFormat[] = ['text', 'json', 'toon'];

/** Serialize a successful, output-validated tool result to stdout text. */
export async function serializeResult(
  result: unknown,
  format: OutputFormat,
): Promise<string> {
  switch (format) {
    case 'json':
      return JSON.stringify(result, null, 2) + '\n';
    case 'toon':
      return (await loadToon()).encode(result) + '\n';
    case 'text':
      return renderText(result);
  }
}

/**
 * Serialize an error to stderr text. Reuses `buildErrorEnvelope` — the same
 * contract REST and MCP emit — so a plain `Error` is redacted to a generic 500
 * and an `AgentError` keeps its `code`/`message`/`hint`. Errors are the ONLY
 * enveloped output; success is bare.
 */
export function serializeError(err: unknown): string {
  return JSON.stringify(buildErrorEnvelope(err), null, 2) + '\n';
}

/** Human-readable text: primitives raw, objects as pretty JSON. */
function renderText(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'object') return JSON.stringify(result, null, 2) + '\n';
  return String(result) + '\n';
}

type ToonModule = {encode: (v: unknown) => string};
let toonModule: ToonModule | undefined;

async function loadToon(): Promise<ToonModule> {
  if (toonModule) return toonModule;
  // Non-literal specifier: keep '@toon-format/toon' a true optional peer (not
  // in the lockfile) so tsc doesn't resolve its types and the build stays green
  // without it installed. Same doctrine as `ai` in @agentback/agents.
  const spec = '@toon-format/toon';
  try {
    toonModule = (await import(spec)) as ToonModule;
  } catch (err) {
    throw new Error(
      `@agentback/command: --format toon needs the optional peer dependency ` +
        `'@toon-format/toon'. Install it: pnpm add @toon-format/toon`,
      {cause: err},
    );
  }
  return toonModule;
}
