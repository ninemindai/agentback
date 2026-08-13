// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * The controller-liveness gate must run BEFORE the multipart parser: a
 * retracted (unbound) controller's upload route must not stream files into
 * the FileStore on its way to a 404 — retraction that leaks side effects is
 * not retraction. (Outside-voice finding C1 on PR #51.)
 */

import {afterEach, describe, expect, it} from 'vitest';
import {z} from 'zod';
import {api, post, fileField} from '@agentback/openapi';
import {FILE_STORE, InMemoryFileStore} from '@agentback/files';
import {RestApplication} from '../../rest.application.js';

const Upload = z.object({
  file: fileField({maxSize: 1000, mimeTypes: ['text/plain']}),
});

@api({basePath: '/gated'})
class GatedUploadController {
  @post('/', {body: Upload})
  async upload(input: {body: z.infer<typeof Upload>}) {
    return {key: input.body.file.key ?? null};
  }
}

class CountingStore extends InMemoryFileStore {
  puts = 0;
  override async put(
    ...args: Parameters<InMemoryFileStore['put']>
  ): ReturnType<InMemoryFileStore['put']> {
    this.puts++;
    return super.put(...args);
  }
}

describe('upload route liveness gate', () => {
  let app: RestApplication;

  afterEach(async () => app.stop());

  it('an unbound controller 404s BEFORE the multipart parser stores anything', async () => {
    app = new RestApplication({});
    app.configure('servers.RestServer').to({port: 0, host: '127.0.0.1'});
    const store = new CountingStore();
    app.bind(FILE_STORE).to(store);
    app.restController(GatedUploadController);
    await app.start();
    const url = `${(await app.restServer).url}/gated/`;

    const form = new FormData();
    form.set('file', new Blob(['hello'], {type: 'text/plain'}), 'a.txt');
    const before = await fetch(url, {method: 'POST', body: form});
    expect(before.status).toBe(200);
    expect(store.puts).toBe(1);

    app.unbind('controllers.GatedUploadController');

    const form2 = new FormData();
    form2.set('file', new Blob(['leak?'], {type: 'text/plain'}), 'b.txt');
    const after = await fetch(url, {method: 'POST', body: form2});
    expect(after.status).toBe(404);
    // The load-bearing assertion: the parser never ran, nothing was stored.
    expect(store.puts).toBe(1);
  });
});
