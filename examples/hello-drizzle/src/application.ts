// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {getTableName} from 'drizzle-orm';
import {BindingScope} from '@agentback/core';
import {bindSchema} from '@agentback/openapi';
import {RestApplication} from '@agentback/rest';
import {MCPComponent} from '@agentback/mcp';
import {UsersController} from './controllers/users.controller.js';
import {users, NewUser, User} from './db/schema.js';
import {InMemoryUserStore, USER_STORE} from './user-store.js';

/**
 * hello-drizzle application: REST + MCP from one DI container, with the
 * `users` table's drizzle-zod schemas as the shared contract.
 *
 * `UsersController` is BOTH `@api` (REST) and `@mcpServer` (MCP). A single
 * `restController(...)` registration binds it ONCE: the core `controller` tag
 * lets RestServer mount its routes, and the `@mcpServer`-inherited
 * `extensionFor(MCP_SERVERS)` membership lets MCPServer discover its tools — so
 * REST and MCP share a single controller instance and a single injected store.
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

    // Register the dual-protocol controller once. `restController` honors the
    // class's `@mcpServer` metadata, so this single binding serves both REST
    // (via the `controller` tag) and MCP (via the extension membership).
    this.restController(UsersController);

    // Name the shared drizzle-zod schemas in the container and tag their source
    // table. This is *enrichment* — the schemas already work as route + tool
    // contracts unregistered; binding them gives the schema-explorer a stable
    // name and the table-origin leg of the provenance graph (drizzle-zod
    // otherwise loses the link back to `users`). The SAME objects the decorators
    // use are bound, so identity still joins REST + MCP usage onto one node.
    const table = getTableName(users);
    bindSchema(this, 'NewUser', NewUser, {table, kind: 'insert'});
    bindSchema(this, 'User', User, {table, kind: 'select'});
  }
}
