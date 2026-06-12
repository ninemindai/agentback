// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Binding} from '@agentback/context';
import type {Component} from '@agentback/core';
import {MCPBindings, noopProgress} from './keys.js';
import {MCPServer} from './mcp.server.js';

/**
 * Component that contributes MCPServer to an Application.
 *
 * Also binds the app-level default for {@link MCPBindings.PROGRESS} (a no-op):
 * entry paths without SDK request extras — direct `callTool`, the inspector —
 * still resolve a `ProgressFn`, so tools injecting it never hit a
 * `ResolutionError`. Transport-driven calls shadow this default with a live
 * relay in the per-request context. The component (not the `MCPServer`
 * constructor) is the seam because it is the declarative place for app-level
 * contributions, and a later `app.bind(MCPBindings.PROGRESS)` cleanly
 * overrides it. Note: `MCPBindings.REQUEST_EXTRA` deliberately has NO
 * app-level default — inject it with `{optional: true}`.
 *
 * @example
 *   const app = new RestApplication();
 *   app.component(MCPComponent);
 *   app.service(EchoTools);  // class decorated with @mcpServer()
 *   await app.start();
 */
export class MCPComponent implements Component {
  servers = {MCPServer};
  bindings = [Binding.bind(MCPBindings.PROGRESS.key).to(noopProgress)];
}
