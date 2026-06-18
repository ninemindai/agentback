// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// One controller, one pair of schemas, two protocols. The SAME `NewUser` /
// `User` Zod schemas derived from the `users` table drive:
//   - the REST `@post('/users')` body + response (and thus /openapi.json)
//   - the MCP `@tool('create_user')` input + output
// That's the whole point: the table is the single source of truth and the
// contract is coherent across the table, REST, OpenAPI, and MCP boundaries.

import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, post} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';
import {NewUser, User} from '../db/schema.js';
import {USER_STORE, type UserStore} from '../user-store.js';

@api({basePath: '/users'})
@mcpServer()
export class UsersController {
  constructor(@inject(USER_STORE) private store: UserStore) {}

  @post('/', {body: NewUser, response: User, status: 201})
  async create(input: {
    body: z.infer<typeof NewUser>;
  }): Promise<z.infer<typeof User>> {
    return this.store.create(input.body);
  }

  @tool('create_user', {
    description: 'Create a user. Same schema chain as POST /users.',
    input: NewUser,
    output: User,
  })
  async createUser(
    input: z.infer<typeof NewUser>,
  ): Promise<z.infer<typeof User>> {
    return this.store.create(input);
  }
}
