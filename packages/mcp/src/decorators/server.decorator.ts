// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {injectable, BindingScope, ContextTags} from '@agentback/context';
import type {TagMap} from '@agentback/context';
import {extensionFor} from '@agentback/core';
import {MCP_SERVERS} from '../keys.js';

/** Options for {@link mcpServer}. */
export interface McpServerOptions {
  /** Binding name (`ContextTags.NAME`). */
  name?: string;
  /**
   * Binding scope. Defaults to `SINGLETON` — tool classes are typically
   * stateless handlers whose per-request data arrives through method-level
   * `@inject`, so one shared instance is reused. Override (e.g. `TRANSIENT`)
   * for a tool that holds per-resolution state.
   */
  scope?: BindingScope;
  /** Extra tags to merge onto the binding. */
  tags?: TagMap;
}

/**
 * Mark a class as a contributor of MCP tools/resources/prompts. Built on
 * `@injectable`, so the class is a normal DI binding tagged `mcpServer` — the
 * MCP server discovers it by that tag and resolves it (with constructor
 * `@inject`) through whatever binding registered it (`app.service`,
 * `app.controller`, a manual `bind`). Defaults to singleton scope.
 *
 * @param nameOrOptions - a binding name, or {@link McpServerOptions} for
 *   scope/tags customization.
 */
export function mcpServer(
  nameOrOptions?: string | McpServerOptions,
): ClassDecorator {
  const options: McpServerOptions =
    typeof nameOrOptions === 'string'
      ? {name: nameOrOptions}
      : (nameOrOptions ?? {});
  return injectable(
    {
      scope: options.scope ?? BindingScope.SINGLETON,
      tags: {
        ...options.tags,
        ...(options.name ? {[ContextTags.NAME]: options.name} : {}),
      },
    },
    // Mark the class as an extension of the MCP_SERVERS extension point.
    extensionFor(MCP_SERVERS),
  );
}
