// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingScope, extensionFor} from '@agentback/core';
import {RestApplication, REST_CONTROLLER_TAG} from '@agentback/rest';
import {MCPComponent, MCP_SERVERS} from '@agentback/mcp';
import {UsersController} from './controllers/users.controller.js';
import {InMemoryUserStore, USER_STORE} from './user-store.js';

/**
 * hello-drizzle application: REST + MCP from one DI container, with the
 * `users` table's drizzle-zod schemas as the shared contract.
 *
 * `UsersController` is BOTH `@api` (REST) and `@mcpServer` (MCP). It's bound
 * ONCE, tagged `restController` (so RestServer mounts its routes) and marked an
 * `MCP_SERVERS` extension (so MCPServer discovers its tools), so REST and MCP
 * share a single controller instance and a single injected store.
 */
export class HelloDrizzleApplication extends RestApplication {
  constructor() {
    super();

    this.component(MCPComponent);
    this.configure('servers.MCPServer').to({
      name: 'hello-drizzle',
      version: '0.0.1',
      transports: {stdio: false},
    });

    // Default data-access port: in-memory so the example runs in CI with no
    // database. Swap for a Postgres-backed store via DI (see README).
    this.bind(USER_STORE)
      .toClass(InMemoryUserStore)
      .inScope(BindingScope.SINGLETON);

    // Register the dual-protocol controller once: REST discovery tag + the
    // MCP_SERVERS extension marker.
    this.bind('controllers.UsersController')
      .toClass(UsersController)
      .tag(REST_CONTROLLER_TAG)
      .apply(extensionFor(MCP_SERVERS));
  }
}
