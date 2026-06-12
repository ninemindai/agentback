// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {OpenApiSpec} from '@agentback/openapi';

/**
 * AX (agent experience) artifacts: the same route registry that emits
 * /openapi.json also describes itself to language models. `RestServer`
 * serves `/llms.txt` (a compact index, per the llmstxt.org convention) and
 * `/llms-full.txt` (full per-endpoint schemas) by default, and
 * {@link generateAgentContext} renders an agent-context markdown file
 * (CLAUDE.md / skill-file shape) describing the live API.
 */

/**
 * A contributed section appended to the generated llms.txt documents.
 * Components bind sections under {@link AX_SECTION_TAG} — e.g.
 * `@agentback/mcp-http` contributes an "MCP" section listing the
 * tool surface when the transport is installed.
 */
export interface AxSection {
  title: string;
  body: string;
}

/** Binding tag for {@link AxSection} values contributed by components. */
export const AX_SECTION_TAG = 'ax.section';

export interface AxOptions {
  /** Document title. Default: the spec's `info.title`. */
  title?: string;
  /** One-line summary. Default: the spec's `info.description`. */
  description?: string;
  /** Where the OpenAPI document is served. Default `/openapi.json`. */
  specPath?: string;
  /** Extra sections appended after the endpoint listing. */
  sections?: AxSection[];
}

interface OperationLike {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    schema?: unknown;
  }[];
  requestBody?: {content?: Record<string, {schema?: unknown}>};
  responses?: Record<
    string,
    {description?: string; content?: Record<string, {schema?: unknown}>}
  >;
  security?: unknown[];
}

const HTTP_VERBS = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'options',
  'head',
  'trace',
] as const;

function listOperations(
  spec: OpenApiSpec,
): {verb: string; path: string; op: OperationLike}[] {
  const out: {verb: string; path: string; op: OperationLike}[] = [];
  const paths = (spec as {paths?: Record<string, unknown>}).paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const verb of HTTP_VERBS) {
      const op = (item as Record<string, unknown>)[verb];
      if (op && typeof op === 'object') {
        out.push({verb: verb.toUpperCase(), path, op: op as OperationLike});
      }
    }
  }
  return out;
}

function specInfo(spec: OpenApiSpec): {title: string; description?: string} {
  const info = (spec as {info?: {title?: string; description?: string}}).info;
  return {
    title: info?.title ?? 'API',
    description: info?.description,
  };
}

function oneLine(text: string | undefined): string | undefined {
  return text?.split('\n')[0]?.trim() || undefined;
}

/** The error-contract section shared by every generated document. */
const ERROR_CONTRACT = `## Error contract

Errors are JSON: \`{"error": {"statusCode", "code", "message", "issues?",
"schema?", "retryable", "hint?"}}\`. \`code\` is a stable machine-readable
identifier — never parse \`message\`. Validation failures list per-field
\`issues\` (path, expected, received) and include the violated section's JSON
Schema as \`schema\`. \`retryable: true\` means retrying the same operation
with corrected input can succeed; \`hint\` is a one-line remediation
instruction.`;

function header(spec: OpenApiSpec, opts: AxOptions): string[] {
  const info = specInfo(spec);
  const lines = [`# ${opts.title ?? info.title}`, ''];
  const description = opts.description ?? oneLine(info.description);
  if (description) lines.push(`> ${description}`, '');
  lines.push(
    `This service is described by an OpenAPI 3.1 document at ` +
      `\`${opts.specPath ?? '/openapi.json'}\`.`,
    '',
  );
  return lines;
}

function sectionBlocks(opts: AxOptions): string[] {
  const lines: string[] = [];
  for (const section of opts.sections ?? []) {
    lines.push(`## ${section.title}`, '', section.body.trim(), '');
  }
  return lines;
}

/**
 * Render the compact `/llms.txt` document (llmstxt.org shape): title,
 * one-line summary, an endpoint index with one line per operation, the
 * error contract, and any contributed sections.
 */
export function generateLlmsTxt(
  spec: OpenApiSpec,
  opts: AxOptions = {},
): string {
  const lines = header(spec, opts);
  const ops = listOperations(spec);
  if (ops.length) {
    lines.push('## Endpoints', '');
    for (const {verb, path, op} of ops) {
      const summary = oneLine(op.summary) ?? oneLine(op.description);
      lines.push(`- \`${verb} ${path}\`${summary ? ` — ${summary}` : ''}`);
    }
    lines.push('');
  }
  lines.push(ERROR_CONTRACT, '');
  lines.push(...sectionBlocks(opts));
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

/**
 * Render the expanded `/llms-full.txt` document: every operation with its
 * parameter, request-body, and response schemas inlined as JSON Schema —
 * enough for an agent to call the API without fetching /openapi.json.
 */
export function generateLlmsFullTxt(
  spec: OpenApiSpec,
  opts: AxOptions = {},
): string {
  const lines = header(spec, opts);
  const ops = listOperations(spec);
  if (ops.length) lines.push('## Endpoints', '');
  for (const {verb, path, op} of ops) {
    lines.push(`### \`${verb} ${path}\``, '');
    const summary = op.summary ?? op.description;
    if (summary) lines.push(summary.trim(), '');
    const params = op.parameters ?? [];
    if (params.length) {
      lines.push('Parameters:', '');
      for (const p of params) {
        lines.push(
          `- \`${p.name}\` (${p.in}${p.required ? ', required' : ''}): ` +
            `${JSON.stringify(p.schema ?? {})}`,
        );
      }
      lines.push('');
    }
    const bodySchema = pickJsonSchema(op.requestBody?.content);
    if (bodySchema !== undefined) {
      lines.push('Request body (application/json):', '');
      lines.push('```json', JSON.stringify(bodySchema, null, 2), '```', '');
    }
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      const schema = pickJsonSchema(response.content);
      const label = `Response ${status}${
        response.description ? ` — ${oneLine(response.description)}` : ''
      }`;
      if (schema !== undefined) {
        lines.push(
          `${label}:`,
          '',
          '```json',
          JSON.stringify(schema, null, 2),
          '```',
          '',
        );
      } else {
        lines.push(`${label}.`, '');
      }
    }
  }
  lines.push(ERROR_CONTRACT, '');
  lines.push(...sectionBlocks(opts));
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

function pickJsonSchema(
  content: Record<string, {schema?: unknown}> | undefined,
): unknown {
  if (!content) return undefined;
  const media = content['application/json'] ?? Object.values(content)[0];
  return media?.schema;
}

export interface AgentContextOptions extends AxOptions {
  /** The base URL agents should call, e.g. `http://127.0.0.1:3000`. */
  baseUrl?: string;
}

/**
 * Render an agent-context markdown document (a CLAUDE.md / skill-file shape)
 * describing the live API: base URL, auth schemes, the error contract, and
 * every endpoint with its schemas. Write it to disk next to your code so a
 * coding agent's first encounter with the service is the full manual:
 *
 * ```ts
 * const spec = await server.getApiSpec();
 * await fs.writeFile('AGENT.md', generateAgentContext(spec, {baseUrl}));
 * ```
 */
export function generateAgentContext(
  spec: OpenApiSpec,
  opts: AgentContextOptions = {},
): string {
  const lines = header(spec, opts);
  if (opts.baseUrl) {
    lines.push(`Base URL: \`${opts.baseUrl}\``, '');
  }
  const schemes = (
    spec as {
      components?: {securitySchemes?: Record<string, unknown>};
    }
  ).components?.securitySchemes;
  if (schemes && Object.keys(schemes).length) {
    lines.push('## Authentication', '');
    for (const [name, scheme] of Object.entries(schemes)) {
      lines.push(`- \`${name}\`: ${JSON.stringify(scheme)}`);
    }
    lines.push('');
  }
  // The endpoint detail is the llms-full body minus its own header.
  const full = generateLlmsFullTxt(spec, opts);
  const endpointsAt = full.indexOf('## Endpoints');
  lines.push(endpointsAt >= 0 ? full.slice(endpointsAt) : full);
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
