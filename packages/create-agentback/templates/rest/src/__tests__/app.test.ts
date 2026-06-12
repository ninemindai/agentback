import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {Application} from '../application.js';

describe('{{name}}', () => {
  it('serves the REST route', async () => {
    await using t = await createTestApp(Application);
    const r = await t.http.get('/greet/hello/world').expect(200);
    expect(r.body).toEqual({greeting: 'Hello, world!'});
  });

  it('validates input via the Zod schema', async () => {
    await using t = await createTestApp(Application);
    await t.http.post('/greet/echo').send({text: ''}).expect(422);
  });
});
