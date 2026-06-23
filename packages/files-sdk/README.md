# @agentback/files-sdk

> A `FileStore` adapter that bridges [`@agentback/files`](../files) to
> [`files-sdk`](https://files-sdk.dev) — one port, 40+ storage backends.

`@agentback/files-s3` hand-wires the AWS SDK to the `FileStore` port. This
package does the same for **`files-sdk`**, whose single `Files` API already
abstracts S3, R2, GCS, Azure Blob, Vercel Blob, Netlify Blobs, MinIO, the local
filesystem, and ~30 more behind one interface. Pick a `files-sdk` adapter, wrap
it once, and every AgentBack upload/download recipe (`fileField()` /
`fileResponse(...)`) runs against that backend unchanged.

## Usage

```ts
import {FilesSdkFileStore} from '@agentback/files-sdk';
import {s3} from 'files-sdk/s3';          // or files-sdk/r2, /gcs, /azure, /fs, …
import {FILE_STORE} from '@agentback/files';

app.bind(FILE_STORE).to(
  new FilesSdkFileStore({adapter: s3({bucket: 'uploads'}), prefix: 'app/'}),
);
```

`files-sdk` is a **peer dependency** — install it plus the peer deps of the
specific adapter you use (e.g. `@aws-sdk/client-s3` for `s3()`); the filesystem
adapter needs nothing extra.

## How the bridge works

| `FileStore` | delegates to | bridge detail |
|---|---|---|
| `put(key, body, opts)` | `files.upload` | `Buffer` is already a `Uint8Array` (passes through); `Readable` → `Readable.toWeb()`. `filename` rides in `metadata` (when the backend supports metadata). |
| `get(key)` | `files.download` | body stream ← `Readable.fromWeb(sf.stream())`; `FilesError('NotFound')` → `FileNotFoundError`. |
| `stat(key)` | `files.head` | metadata only (no body transfer); maps `type`→`contentType`, epoch `lastModified`→`Date`; `NotFound` → `FileNotFoundError`. |
| `exists` / `delete` | `files.exists` / `files.delete` | `delete` swallows `NotFound` to stay idempotent. |
| `presignedGet` / `presignedPut` | `files.url` / `files.signedUploadUrl` | **present only when** `files.capabilities.signedUrl.supported` — so S3/R2 stores can presign and a filesystem store reports "unsupported" by omitting the methods. |

The Node ⇄ Web stream conversion is the only real impedance, and it is isolated
in `toBody()` / `get()` so the same store can run edge-native (Workers/Bun/Deno)
later, where the bytes are already Web streams.

## Scope

The `FileStore` port stays minimal: `files-sdk`'s `copy`/`move`/`list`/`search`,
byte-range reads, resumable uploads, and plugins are **not** projected onto the
port. Reach for the underlying `files-sdk` `Files` instance directly if you need
them.

## Testing

The package runs the shared `@agentback/files/testing` conformance suite against
the filesystem adapter — no credentials, no external service — so the bridge is
verified in CI exactly like `FsFileStore`.
