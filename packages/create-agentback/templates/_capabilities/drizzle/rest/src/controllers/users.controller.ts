import {z} from 'zod';
import {inject} from '@agentback/core';
import {api, post} from '@agentback/openapi';
import {NewUser, User} from '../db/schema.js';
import {USER_STORE, type UserStore} from '../stores/user-store.js';

@api({basePath: '/users'})
export class UsersController {
  constructor(@inject(USER_STORE) private store: UserStore) {}

  @post('/', {body: NewUser, response: User, status: 201})
  async create(input: {
    body: z.infer<typeof NewUser>;
  }): Promise<z.infer<typeof User>> {
    return this.store.create(input.body);
  }
}
