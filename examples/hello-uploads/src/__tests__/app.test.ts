// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {createTestApp} from '@agentback/testing';
import {HelloUploadsApplication} from '../application.js';

describe('hello-uploads', () => {
  it('uploads, lists, and downloads a file scoped to the owner', async () => {
    await using t = await createTestApp(HelloUploadsApplication);

    const up = await t.http
      .post('/files/')
      .set('x-user-id', 'alice')
      .field('label', 'notes')
      .attach('file', Buffer.from('hello uploads'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    expect(up.body).toMatchObject({
      filename: 'notes.txt',
      mimeType: 'text/plain',
      size: 13,
      label: 'notes',
    });

    const id: string = up.body.id;
    const list = await t.http
      .get('/files/')
      .set('x-user-id', 'alice')
      .expect(200);
    expect(list.body.map((r: {id: string}) => r.id)).toContain(id);

    const down = await t.http
      .get(`/files/${id}`)
      .set('x-user-id', 'alice')
      .expect(200);
    expect(down.text).toBe('hello uploads');
    expect(down.headers['accept-ranges']).toBe('bytes');
  });

  it('serves a byte range as 206 (serveFile)', async () => {
    await using t = await createTestApp(HelloUploadsApplication);
    const up = await t.http
      .post('/files/')
      .set('x-user-id', 'alice')
      .attach('file', Buffer.from('hello uploads'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    const res = await t.http
      .get(`/files/${up.body.id}`)
      .set('x-user-id', 'alice')
      .set('Range', 'bytes=0-4')
      .expect(206);
    expect(res.text).toBe('hello');
    expect(res.headers['content-range']).toBe('bytes 0-4/13');
  });

  it('enforces ownership on download (403) and isolates listings', async () => {
    await using t = await createTestApp(HelloUploadsApplication);
    const up = await t.http
      .post('/files/')
      .set('x-user-id', 'alice')
      .attach('file', Buffer.from('private'), {
        filename: 'p.txt',
        contentType: 'text/plain',
      })
      .expect(201);

    await t.http
      .get(`/files/${up.body.id}`)
      .set('x-user-id', 'bob')
      .expect(403);
    const bobList = await t.http
      .get('/files/')
      .set('x-user-id', 'bob')
      .expect(200);
    expect(bobList.body).toEqual([]);
  });

  it('emits multipart/form-data (file = binary) in the OpenAPI doc', async () => {
    await using t = await createTestApp(HelloUploadsApplication);
    const spec = await t.http.get('/openapi.json').expect(200);
    const paths = spec.body.paths as Record<
      string,
      {post?: {requestBody?: {content: Record<string, unknown>}}}
    >;
    const postOp = Object.values(paths)
      .map(p => p.post)
      .find(p => p?.requestBody);
    expect(postOp).toBeTruthy();
    expect(Object.keys(postOp!.requestBody!.content)).toContain(
      'multipart/form-data',
    );
  });
});
