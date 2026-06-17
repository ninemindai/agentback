import {z} from 'zod';
import {inject} from '@agentback/core';
import {mcpServer, tool} from '@agentback/mcp';
import {NewUser, User} from '../db/schema.js';
import {USER_STORE, type UserStore} from '../stores/user-store.js';

@mcpServer()
export class UsersTools {
  constructor(@inject(USER_STORE) private store: UserStore) {}

  @tool('create_user', {
    description: 'Create a user from the table-derived Zod schema.',
    input: NewUser,
    output: User,
  })
  async createUser(
    input: z.infer<typeof NewUser>,
  ): Promise<z.infer<typeof User>> {
    return this.store.create(input);
  }
}
