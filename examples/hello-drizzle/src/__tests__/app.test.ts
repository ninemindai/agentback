// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Proves the ONE schema chain end-to-end: the `users` table's drizzle-zod
// `NewUser`/`User` schemas validate the REST body, shape the REST response,
// AND drive the MCP `create_user` tool — same artifacts, both protocols.

import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {HelloDrizzleApplication} from '../application.js';
import {InMemoryUserStore, USER_STORE} from '../user-store.js';

describe('hello-drizzle', () => {
  it('POST /users validates NewUser and returns a User-shaped row', async () => {
    await using t = await createTestApp(HelloDrizzleApplication, {
      overrides: {[USER_STORE.key]: new InMemoryUserStore()},
    });

    const res = await t.http
      .post('/users')
      .send({email: 'ada@example.com', name: 'Ada'})
      .expect(201);

    expect(res.body).toMatchObject({
      id: expect.any(Number),
      email: 'ada@example.com',
      name: 'Ada',
    });
    // createdAt is a timestamp column — serialized as an ISO string over JSON.
    expect(typeof res.body.createdAt).toBe('string');
  });

  it('rejects an invalid body with 422', async () => {
    await using t = await createTestApp(HelloDrizzleApplication);
    // `email` missing → NewUser validation fails before the handler runs.
    await t.http.post('/users').send({name: 'No Email'}).expect(422);
  });

  it('MCP tool create_user uses the same schema chain', async () => {
    await using t = await createTestApp(HelloDrizzleApplication);

    const tools = await t.mcp.listTools();
    expect(tools.tools.map(x => x.name)).toContain('create_user');

    const result = await t.mcp.callTool({
      name: 'create_user',
      arguments: {email: 'grace@example.com', name: 'Grace'},
    });
    const out = (result as unknown as {structuredContent: {name: string}})
      .structuredContent;
    expect(out).toMatchObject({email: 'grace@example.com', name: 'Grace'});
  });
});
