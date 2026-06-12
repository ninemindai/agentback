// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import supertest from 'supertest';
import {
  api,
  get,
  post,
  registerJSONSchemaConverter,
} from '@agentback/openapi';
import type {StandardSchemaV1} from '@agentback/openapi';
import {RestApplication} from '../../rest.application.js';

/** Minimal non-Zod Standard Schema vendor: object of required strings. */
function fakeObjectSchema(keys: string[]) {
  const schema: StandardSchemaV1<unknown, Record<string, string>> & {
    __keys: string[];
  } = {
    __keys: keys,
    '~standard': {
      version: 1,
      vendor: 'fake-rest',
      validate(value: unknown) {
        if (value == null || typeof value !== 'object') {
          return {issues: [{message: 'expected an object'}]};
        }
        const out: Record<string, string> = {};
        for (const k of keys) {
          const v = (value as Record<string, unknown>)[k];
          if (typeof v !== 'string' || v.length === 0) {
            return {
              issues: [
                {message: `expected non-empty string at ${k}`, path: [k]},
              ],
            };
          }
          out[k] = v;
        }
        return {value: out};
      },
    },
  };
  return schema;
}

registerJSONSchemaConverter('fake-rest', s => {
  const keys = (s as unknown as {__keys: string[]}).__keys;
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map(k => [k, {type: 'string'}])),
    required: keys,
  };
});

const ItemPath = fakeObjectSchema(['id']);
const NoteBody = fakeObjectSchema(['note']);

@api({basePath: '/fake'})
class FakeVendorController {
  @get('/items/{id}', {path: ItemPath})
  async item(input: {path: Record<string, string>}) {
    return {got: input.path.id};
  }

  @post('/notes', {body: NoteBody})
  async note(input: {body: Record<string, string>}) {
    return {note: input.body.note};
  }
}

describe('Standard Schema vendors through REST dispatch (integration)', () => {
  let app: RestApplication;
  let client: ReturnType<typeof supertest>;

  beforeAll(async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    app.restController(FakeVendorController);
    await app.start();
    const server = await app.restServer;
    client = supertest(server.url);
  });

  afterAll(async () => {
    await app.stop();
  });

  it('validates path params via the ~standard interface', async () => {
    const r = await client.get('/fake/items/42').expect(200);
    expect(r.body).toEqual({got: '42'});
  });

  it('rejects invalid bodies with 422 + issue details', async () => {
    const r = await client.post('/fake/notes').send({note: ''}).expect(422);
    expect(r.body.error.details[0].message).toContain('non-empty string');
  });

  it('accepts valid bodies', async () => {
    const r = await client.post('/fake/notes').send({note: 'hi'}).expect(200);
    expect(r.body).toEqual({note: 'hi'});
  });

  it('emits OpenAPI parameters/body from the registered converter', async () => {
    const r = await client.get('/openapi.json').expect(200);
    const op = r.body.paths['/fake/items/{id}'].get;
    expect(op.parameters).toEqual([
      {name: 'id', in: 'path', required: true, schema: {type: 'string'}},
    ]);
  });
});
