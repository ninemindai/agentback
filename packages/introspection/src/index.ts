// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {CoreBindings, inject, type Context} from '@agentback/core';
import {loggers} from '@agentback/common';
import {AgentError} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';
import {buildOkfBundle, summarizeOkfBundle} from '@agentback/schema-explorer';
import {
  IntrospectionKind,
  IntrospectionNode,
  buildInventory,
  getNode,
} from './model.js';

export * from './model.js';

const log = loggers('agentback:introspection');

/**
 * Run a read-only builder, translating an unexpected throw into a useful
 * AgentError (500) so the agent sees something actionable instead of the
 * redacted generic `internal_error`. An AgentError thrown deliberately
 * (e.g. getNode's 404 not_found) passes through unchanged.
 */
function tryBuild<T>(what: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AgentError) throw err;
    log.error('introspection failed to build %s: %o', what, err);
    throw new AgentError(`Introspection failed to build ${what}.`, {
      status: 500,
      code: 'introspection_error',
    });
  }
}

const InventoryInput = z.object({
  kind: IntrospectionKind.optional().describe(
    'Filter to one node kind; omit for all kinds.',
  ),
});
const InventoryOutput = z.object({nodes: z.array(IntrospectionNode)});

const GetInput = z.object({
  kind: IntrospectionKind.describe('Node kind to fetch.'),
  id: z
    .string()
    .describe(
      'Node id from inventory: a binding key, schema id, "VERB /path", or tool name.',
    ),
});
const GetOutput = z.object({
  kind: IntrospectionKind,
  id: z.string(),
  detail: z.unknown(),
});

const OkfInput = z.object({});
const OkfOutput = z.object({
  files: z.array(z.object({path: z.string(), content: z.string()})),
});

const OkfListOutput = z.object({
  okfVersion: z.string(),
  totalBytes: z
    .number()
    .describe('Total bytes of the full bundle, for budgeting before fetching.'),
  files: z.array(
    z.object({
      path: z.string(),
      title: z.string(),
      description: z.string(),
      type: z.string().optional(),
      bytes: z.number(),
    }),
  ),
});

const OkfFilesInput = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .describe(
      'Paths from list_okf_files, e.g. ["schemas/user.md"]. Batch them: one ' +
        'call for everything you need beats one call per file.',
    ),
});
const OkfFilesOutput = z.object({
  files: z.array(z.object({path: z.string(), content: z.string()})),
});

/**
 * Read-only introspection of the running app, for an agent to ground itself in
 * the live instance. NEVER invokes a route or tool and NEVER resolves a
 * secret-bearing binding value (bindings are metadata-only); only schema-tagged
 * bindings are resolved, to their Zod object. Evolution happens through the
 * coding agent editing source, not here.
 */
@mcpServer()
export class IntrospectionTools {
  constructor(
    @inject(CoreBindings.APPLICATION_INSTANCE)
    private readonly app: Context,
  ) {}

  @tool('inventory', {
    description:
      "List the live application's nodes (bindings, schema entities, routes, tools). Read-only; bindings are metadata only, never values.",
    input: InventoryInput,
    output: InventoryOutput,
  })
  async inventory(
    input: z.infer<typeof InventoryInput>,
  ): Promise<z.infer<typeof InventoryOutput>> {
    return {
      nodes: tryBuild('inventory', () => buildInventory(this.app, input.kind)),
    };
  }

  @tool('get', {
    description:
      "Fetch one node's detail by selector {kind,id}. Bindings return metadata only (never a resolved value).",
    input: GetInput,
    output: GetOutput,
  })
  async get(
    input: z.infer<typeof GetInput>,
  ): Promise<z.infer<typeof GetOutput>> {
    // getNode throws AgentError(404) for unknown ids; tryBuild passes it through.
    return {
      kind: input.kind,
      id: input.id,
      detail: tryBuild('node detail', () => getNode(this.app, input)),
    };
  }

  @tool('list_okf_files', {
    description:
      "Table of contents for the app's OKF knowledge bundle: every document's path, title, description and size, without the bodies. Start here, then fetch only what you need with get_okf_files. Cheaper than get_okf_bundle on any non-trivial app.",
    input: OkfInput,
    output: OkfListOutput,
  })
  async listOkfFiles(
    _input: z.infer<typeof OkfInput>,
  ): Promise<z.infer<typeof OkfListOutput>> {
    return tryBuild('OKF summary', () =>
      summarizeOkfBundle(buildOkfBundle(this.app)),
    );
  }

  @tool('get_okf_files', {
    description:
      'Fetch specific OKF documents by path, as listed by list_okf_files. Batch every path you need into one call.',
    input: OkfFilesInput,
    output: OkfFilesOutput,
  })
  async getOkfFiles(
    input: z.infer<typeof OkfFilesInput>,
  ): Promise<z.infer<typeof OkfFilesOutput>> {
    const bundle = tryBuild('OKF bundle', () => buildOkfBundle(this.app));
    const byPath = new Map(bundle.files.map(f => [f.path, f]));
    const missing = input.paths.filter(p => !byPath.has(p));
    if (missing.length) {
      // Name what exists rather than just what failed: an agent that guessed a
      // path can correct itself from the error instead of re-listing.
      throw new AgentError(`Unknown OKF path(s): ${missing.join(', ')}.`, {
        status: 404,
        code: 'okf_path_not_found',
        hint: `Use list_okf_files. Available: ${bundle.files
          .map(f => f.path)
          .join(', ')}`,
      });
    }
    return {files: input.paths.map(p => byPath.get(p)!)};
  }

  @tool('get_okf_bundle', {
    description:
      "Return the app's whole OKF knowledge bundle for verbatim ingestion. Prefer list_okf_files + get_okf_files unless you genuinely want everything — this returns every document in full.",
    input: OkfInput,
    output: OkfOutput,
  })
  async getOkfBundle(
    _input: z.infer<typeof OkfInput>,
  ): Promise<z.infer<typeof OkfOutput>> {
    return {
      files: tryBuild('OKF bundle', () => buildOkfBundle(this.app).files),
    };
  }
}
