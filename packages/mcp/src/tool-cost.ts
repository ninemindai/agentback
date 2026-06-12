// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Context-budget governance: every tool definition an MCP server exposes is
 * paid for in the caller's context window on every `tools/list`. This module
 * treats that cost as a budget — it token-prices each tool's wire entry
 * (name + title + description + input/output JSON Schema) so bloated tools
 * are visible before an agent pays for them.
 *
 * The estimate uses the ~4 characters/token heuristic, which is accurate to
 * within ~15% for JSON-heavy English text across current tokenizers — good
 * enough to rank tools and budget a surface, without a tokenizer dependency.
 */

/** Approximate LLM token count for a string (chars/4 heuristic). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** The wire shape of one `tools/list` entry, as priced. */
export interface ToolDefinitionLike {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
}

export interface ToolCostEntry {
  name: string;
  /** Serialized size of the tool's `tools/list` entry. */
  bytes: number;
  /** Estimated token cost of the entry (chars/4). */
  tokens: number;
}

export interface ToolCostReport {
  tools: ToolCostEntry[];
  totalBytes: number;
  /** What one `tools/list` costs a caller's context window, in tokens. */
  totalTokens: number;
}

/**
 * Price a tool surface: per-tool token estimates (sorted most-expensive
 * first) and the total `tools/list` cost.
 */
export function toolCostReport(tools: ToolDefinitionLike[]): ToolCostReport {
  const entries = tools.map(t => {
    const serialized = JSON.stringify({
      name: t.name,
      ...(t.title !== undefined ? {title: t.title} : {}),
      ...(t.description !== undefined ? {description: t.description} : {}),
      ...(t.inputSchema !== undefined ? {inputSchema: t.inputSchema} : {}),
      ...(t.outputSchema !== undefined ? {outputSchema: t.outputSchema} : {}),
    });
    return {
      name: t.name,
      bytes: serialized.length,
      tokens: estimateTokens(serialized),
    };
  });
  entries.sort((a, b) => b.tokens - a.tokens);
  return {
    tools: entries,
    totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    totalTokens: entries.reduce((sum, e) => sum + e.tokens, 0),
  };
}

/**
 * Render a report as an aligned text table, flagging tools above
 * `warnTokens` (default 500 — a tool definition that large usually wants a
 * tighter description or a narrower schema).
 */
export function formatToolCostReport(
  report: ToolCostReport,
  options: {warnTokens?: number} = {},
): string {
  const warnTokens = options.warnTokens ?? 500;
  const nameWidth = Math.max(4, ...report.tools.map(t => t.name.length));
  const lines = [
    `${'tool'.padEnd(nameWidth)}  ${'tokens'.padStart(7)}  ${'bytes'.padStart(7)}`,
  ];
  for (const t of report.tools) {
    lines.push(
      `${t.name.padEnd(nameWidth)}  ${String(t.tokens).padStart(7)}  ` +
        `${String(t.bytes).padStart(7)}${t.tokens > warnTokens ? '  ⚠ over budget' : ''}`,
    );
  }
  lines.push(
    `${'total'.padEnd(nameWidth)}  ${String(report.totalTokens).padStart(7)}  ` +
      `${String(report.totalBytes).padStart(7)}`,
  );
  return lines.join('\n');
}
