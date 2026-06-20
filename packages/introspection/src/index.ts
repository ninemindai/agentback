// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {z} from 'zod';
import {CoreBindings, inject, type Context} from '@agentback/core';
import {loggers} from '@agentback/common';
import {AgentError} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';
import {buildOkfBundle} from '@agentback/schema-explorer';
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

  @tool('get_okf_bundle', {
    description:
      'Return the OKF knowledge bundle: a portable, schema-indexed snapshot of the whole app for an agent to ingest verbatim. Returns the full bundle (large apps may produce a sizable payload — see the summary/on-demand TODO).',
    input: OkfInput,
    output: OkfOutput,
  })
  async getOkfBundle(
    _input: z.infer<typeof OkfInput>,
  ): Promise<z.infer<typeof OkfOutput>> {
    return {files: tryBuild('OKF bundle', () => buildOkfBundle(this.app).files)};
  }
}
