// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {loggers} from '@agentback/common';
import type {Context} from '@agentback/context';
import {
  MCPBindings,
  selectTools,
  type MCPServer,
  type SelectToolsOptions,
  type ToolBinding,
} from '@agentback/mcp';
import {
  AgentError,
  ErrorCodes,
  schemaToOpenApiSchema,
} from '@agentback/openapi';
import type {UserProfile} from '@agentback/security';
import {argvToBundle} from './argv-bundle.js';
import {renderLlms, toolHelp, usage} from './discovery.js';
import {detectFormat} from './detect.js';
import {
  serializeError,
  serializeResult,
  OUTPUT_FORMATS,
  type OutputFormat,
} from './serialize.js';

const log = loggers('agentback:command');

/** Options for {@link buildCli}: the tool selection plus the CLI principal. */
export interface CliOptions extends SelectToolsOptions {
  /**
   * The identity every command runs as. A CLI has no transport, so there is one
   * local principal (eng review): `@authorize`-guarded tools authorize under
   * it, and metering attributes to it. Omit for the anonymous/local default.
   */
  principal?: UserProfile;
}

/** Injectable output sinks — default to the process streams; tests capture. */
export interface CliIo {
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

/** A built CLI: give it argv (minus node/script), get back an exit code. */
export type CliRunner = (argv: string[], io?: CliIo) => Promise<number>;

interface TopLevel {
  command?: string;
  format?: OutputFormat;
  help: boolean;
  llms: boolean;
  rest: string[];
}

/**
 * Split the framework-global flags (`--format`, `--llms`, `--help`) from the
 * command name and its own flags. The first non-flag token is the command;
 * everything after it is the command's argv, parsed by {@link argvToBundle}.
 */
function parseTop(argv: string[]): TopLevel {
  let command: string | undefined;
  let format: OutputFormat | undefined;
  let help = false;
  let llms = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--format') {
      const v = argv[++i];
      if (v === undefined)
        throw new AgentError('--format needs a value (text|json|toon)', {
          code: ErrorCodes.INVALID_INPUT,
        });
      if (!OUTPUT_FORMATS.includes(v as OutputFormat))
        throw new AgentError(
          `--format must be one of ${OUTPUT_FORMATS.join('|')}, got '${v}'`,
          {code: ErrorCodes.INVALID_INPUT},
        );
      format = v as OutputFormat;
    } else if (a === '--llms') {
      llms = true;
    } else if (a === '--help' || a === '-h') {
      help = true;
    } else if (!command && !a.startsWith('-')) {
      command = a;
    } else {
      rest.push(a);
    }
  }
  return {command, format, help, llms, rest};
}

/**
 * Build a runnable CLI over the app's registered `@tool` classes. The same Zod
 * schema that serves REST/MCP/OpenAPI becomes the flag surface, and every
 * invocation routes through `MCPServer.callTool` — the full dispatch pipeline
 * (Zod validation, `@authorize` voters, metering, output validation). Tool
 * discovery works before `app.start()`; **invocation needs a started app** (DB
 * pools/config/messaging init in lifecycle observers — the caller's `bin` owns
 * `app.start()`/`app.stop()`).
 */
export async function buildCli(
  app: Context,
  opts: CliOptions = {},
): Promise<CliRunner> {
  const {principal, ...selectOpts} = opts;
  const mcp = await app.get<MCPServer>(MCPBindings.SERVER.key);
  const tools = selectTools(mcp.listTools(), selectOpts);
  const byName = new Map<string, ToolBinding>(tools.map(t => [t.meta.name, t]));

  return async (argv, io = {}) => {
    const out = io.stdout ?? (s => process.stdout.write(s));
    const err = io.stderr ?? (s => process.stderr.write(s));
    try {
      const top = parseTop(argv);

      if (top.llms) {
        out(renderLlms(tools));
        return 0;
      }
      if (!top.command) {
        // No command: help is a success (the user asked); bare invocation isn't.
        (top.help ? out : err)(usage(tools));
        return top.help ? 0 : 1;
      }

      const tool = byName.get(top.command);
      if (!tool) {
        err(usage(tools));
        err(`\nunknown command: ${top.command}\n`);
        return 1;
      }
      if (top.help) {
        out(toolHelp(tool));
        return 0;
      }

      const schema = tool.meta.input
        ? schemaToOpenApiSchema(tool.meta.input)
        : undefined;
      const input = argvToBundle(top.rest, schema as Parameters<typeof argvToBundle>[1]);

      if (log.debug.enabled)
        log.debug('command %s input %o', top.command, input);

      const result = await mcp.callTool(top.command, input, {
        principal,
        binding: tool, // captured at build time — skip the by-name scan
      });

      out(await serializeResult(result, top.format ?? detectFormat()));
      return 0;
    } catch (e) {
      err(serializeError(e));
      return 1;
    }
  };
}
