# @agentback/files-s3

> S3-backed `FileStore` adapter for [`@agentback/files`](../files).

Implements the `FileStore` port against any S3-compatible backend (AWS S3,
localstack, MinIO, R2) using AWS SDK v3. Uploads stream through
`@aws-sdk/lib-storage`'s `Upload` (no full-file buffering); downloads stream
from `GetObject`. Ports the proven dapp5 `s3.service` recipe onto the port.

## Usage

```ts
import {S3FileStore} from '@agentback/files-s3';
import {FILE_STORE} from '@agentback/files';

const store = new S3FileStore({
  bucket: 'my-uploads',
  keyPrefix: 'files/',                 // optional namespacing
  clientConfig: {region: 'us-east-1'}, // or pass an existing {client}
});

app.bind(FILE_STORE).to(store);        // the REST file recipe now uses S3
```

- **`put`** streams the body to S3, recording `filename` in object metadata and
  `contentType` as `Content-Type`; returns size + ETag (via a follow-up HEAD).
- **`get`** returns the object stream + metadata; a missing key throws
  `FileNotFoundError` (→ 404 at the REST layer).
- **`exists`/`delete`** map to HeadObject/DeleteObject.
- **`presignedPut`/`presignedGet`** issue time-limited URLs for a
  direct-to-S3 flow (default 15 min).

## Testing

The conformance suite from `@agentback/files/testing` runs against a real
endpoint, gated on env (skipped otherwise — same pattern as the BullMQ/Redis
tests):

```bash
S3_TEST_ENDPOINT=http://localhost:4566 S3_TEST_BUCKET=test \
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test \
  pnpm -F @agentback/files-s3 test
```
