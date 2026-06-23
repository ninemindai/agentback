// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {S3FileStore} from '../../s3-file-store.js';

// Presigning is a local HMAC computation — no network — so these run in CI with
// dummy credentials, unlike the body operations (which need a live endpoint).
function makeStore(): S3FileStore {
  return new S3FileStore({
    bucket: 'test-bucket',
    clientConfig: {
      region: 'us-east-1',
      credentials: {accessKeyId: 'AKIATEST', secretAccessKey: 'secret'},
    },
  });
}

describe('S3FileStore presigned uploads', () => {
  it('returns an unbounded PUT URL when no maxSize is given', async () => {
    const signed = await makeStore().presignedPut('obj-key-1', {
      contentType: 'image/png',
    });
    expect(signed.method).toBe('PUT');
    if (signed.method !== 'PUT') throw new Error('expected PUT');
    expect(signed.url).toContain('obj-key-1');
    expect(signed.url).toContain('X-Amz-Signature');
    expect(signed.headers?.['Content-Type']).toBe('image/png');
  });

  it('returns a size-enforced POST form when maxSize is set', async () => {
    const signed = await makeStore().presignedPut('obj-key-2', {
      maxSize: 1024,
      contentType: 'application/pdf',
    });
    expect(signed.method).toBe('POST');
    if (signed.method !== 'POST') throw new Error('expected POST');
    expect(signed.fields.key).toBe('obj-key-2');
    // The content-length-range condition lives inside the signed base64 policy.
    expect(signed.fields.Policy).toBeTruthy();
    expect(signed.fields['X-Amz-Signature']).toBeTruthy();
  });

  it('honors a keyPrefix in the signed key', async () => {
    const store = new S3FileStore({
      bucket: 'test-bucket',
      keyPrefix: 'uploads/',
      clientConfig: {
        region: 'us-east-1',
        credentials: {accessKeyId: 'AKIATEST', secretAccessKey: 'secret'},
      },
    });
    const signed = await store.presignedPut('obj-key-3', {maxSize: 10});
    if (signed.method !== 'POST') throw new Error('expected POST');
    expect(signed.fields.key).toBe('uploads/obj-key-3');
  });
});
