import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, post} from '@agentback/openapi';
import {mcpServer, tool} from '@agentback/mcp';
import {NewUser, User} from '../db/schema.js';
import {USER_STORE, type UserStore} from '../stores/user-store.js';

// One controller, one schema pair, two protocols. The SAME table-derived Zod
// schemas drive POST /users (REST + OpenAPI) and the create_user MCP tool.
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
