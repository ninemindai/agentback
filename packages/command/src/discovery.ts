// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {schemaToOpenApiSchema} from '@agentback/openapi';
import type {ToolBinding} from '@agentback/mcp';

interface JsonSchema {
  type?: string | string[];
  properties?: Record<
    string,
    {
      type?: string | string[];
      description?: string;
      default?: unknown;
      positional?: boolean;
    }
  >;
  required?: string[];
}

function scalarType(type: string | string[] | undefined): string {
  if (Array.isArray(type)) return type.find(t => t !== 'null') ?? 'string';
  return type ?? 'string';
}

/** One line per command — the top-level help / usage. */
export function usage(tools: ToolBinding[]): string {
  const lines = [
    'Usage: <command> [--flags]   (--format text|json|toon)',
    '       --llms                 machine-readable tool manifest',
    '       <command> --help       flags for one command',
    '',
    'Commands:',
  ];
  for (const t of tools) {
    lines.push(
      `  ${t.meta.name}${t.meta.description ? ` — ${t.meta.description}` : ''}`,
    );
  }
  return lines.join('\n') + '\n';
}

/** Flags for a single command, derived from its input schema. */
export function toolHelp(tool: ToolBinding): string {
  const lines = [
    `${tool.meta.name}${tool.meta.description ? ` — ${tool.meta.description}` : ''}`,
    '',
  ];
  const schema = tool.meta.input
    ? (schemaToOpenApiSchema(tool.meta.input) as JsonSchema)
    : undefined;
  const props = schema?.properties;
  if (props) {
    const required = new Set(schema!.required ?? []);
    const entries = Object.entries(props);
    const positionals = entries.filter(([, s]) => s.positional);
    const flags = entries.filter(([, s]) => !s.positional);

    // Usage line shows positionals before flags.
    const usageArgs = positionals.map(([n]) => `<${n}>`).join(' ');
    lines[0] =
      `${tool.meta.name}${usageArgs ? ` ${usageArgs}` : ''} [--flags]` +
      (tool.meta.description ? `   ${tool.meta.description}` : '');

    if (positionals.length) {
      lines.push('Arguments:');
      for (const [name, spec] of positionals)
        lines.push(
          `  ${name} <${scalarType(spec.type)}>${spec.description ? ` — ${spec.description}` : ''}`,
        );
    }
    if (flags.length) {
      lines.push('Flags:');
      for (const [name, spec] of flags) {
        // A field with a default is optional from the caller's side, even
        // though Zod v4 keeps it in the schema's `required` array.
        const optional = spec.default !== undefined || !required.has(name);
        const req = optional ? '' : ' (required)';
        const def =
          spec.default !== undefined
            ? ` (default: ${JSON.stringify(spec.default)})`
            : '';
        const desc = spec.description ? ` — ${spec.description}` : '';
        lines.push(`  --${name} <${scalarType(spec.type)}>${req}${def}${desc}`);
      }
    }
  } else {
    lines.push('(no flags — this command takes no input)');
  }
  return lines.join('\n') + '\n';
}

/**
 * The `--llms` manifest: a machine-readable list of the **selected** commands
 * (scoped to `include`/`exclude`, not every registered tool), each with its
 * emitted input/output JSON Schema — the same schema every other surface uses.
 */
export function renderLlms(tools: ToolBinding[]): string {
  const manifest = {
    tools: tools.map(t => ({
      name: t.meta.name,
      description: t.meta.description,
      inputSchema: t.meta.input
        ? schemaToOpenApiSchema(t.meta.input)
        : {type: 'object'},
      ...(t.meta.output
        ? {outputSchema: schemaToOpenApiSchema(t.meta.output)}
        : {}),
    })),
  };
  return JSON.stringify(manifest, null, 2) + '\n';
}
