// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it} from 'vitest';
import {runFileStoreConformance} from '@agentback/files/testing';
import {S3FileStore} from '../../index.js';

// Gated like the BullMQ/Redis tests: runs only against a real S3-compatible
// endpoint (localstack/minio/AWS). Set S3_TEST_ENDPOINT + S3_TEST_BUCKET
// (and AWS creds) to exercise it; otherwise it is skipped.
const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET;

if (endpoint && bucket) {
  runFileStoreConformance(
    'S3FileStore',
    () =>
      new S3FileStore({
        bucket,
        keyPrefix: 'files-s3-test/',
        clientConfig: {
          endpoint,
          region: process.env.AWS_REGION ?? 'us-east-1',
          forcePathStyle: true, // localstack/minio path-style addressing
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        },
      }),
  );
} else {
  // eslint-disable-next-line no-console
  console.log(
    '[files-s3] S3_TEST_ENDPOINT / S3_TEST_BUCKET not set — skipping S3 ' +
      'conformance (point them at localstack/minio/AWS to run)',
  );
  describe.skip('S3FileStore conformance (needs S3_TEST_ENDPOINT + S3_TEST_BUCKET)', () => {
    it('skipped — no S3 endpoint configured', () => {});
  });
}
