# `@agentback/files-sdk` — design

**Date:** 2026-06-22
**Status:** prototype (built, conformance-green)
**Branch:** `feat/files-sdk-adapter`

## Goal

Let AgentBack apps store files in any of [`files-sdk`](https://files-sdk.dev)'s
40+ backends (S3, R2, GCS, Azure, Vercel Blob, filesystem, …) without changing
the upload/download recipes, by implementing the existing `FileStore` port as a
thin adapter over `files-sdk`'s server-side `Files` client.

## Why an adapter, not a replacement

`files-sdk` sits at the **same architectural layer** as AgentBack's `FileStore`
port — both are "one interface, many storage backends." The `FileStore` port is
a stable public seam: `fileField()` / `fileResponse()`, the `FILE_STORE` DI
binding, and the conformance suite all depend on it. So `files-sdk` belongs
*below* that seam as one more implementation — exactly the role `S3FileStore`
plays for the AWS SDK. This keeps `files-sdk` (young, single-maintainer, v2.0.0)
swappable without touching a single caller.

## Surface

```ts
interface FilesSdkFileStoreOptions {
  adapter: import('files-sdk').Adapter; // fs(), s3(), r2(), gcs(), …
  prefix?: string;                      // optional key namespacing
}
class FilesSdkFileStore implements FileStore { … }
```

Constructor builds `new Files({adapter, prefix})` and capability-detects presign.

## Bridge mapping (port ⇄ files-sdk server `Files`)

| Port | Delegate | Detail |
|---|---|---|
| `put` | `files.upload(key, body, {contentType, metadata})` | `Buffer` → pass-through (`Buffer extends Uint8Array`); `Readable` → `Readable.toWeb()`. `filename` folded into a reserved `metadata.filename`, only when `capabilities.metadata`. Returns `{key, size, contentType, etag}` from `UploadResult`. |
| `get` | `files.download(key)` | `stream` ← `Readable.fromWeb(sf.stream())`; map `sf.type`→`contentType`, `sf.metadata.filename`→`filename`. `FilesError.code === 'NotFound'` → `FileNotFoundError`. |
| `exists` | `files.exists(key)` | direct. |
| `delete` | `files.delete(key)` | swallow `NotFound` for idempotency. |
| `presignedGet?` | `files.url(key, {expiresIn})` | gated on `capabilities.signedUrl.supported`. |
| `presignedPut?` | `files.signedUploadUrl(key, {expiresIn, contentType?})` | gated likewise; require the PUT form, return `.url` (POST form throws — the string-URL port contract can't carry POST fields). |

### Key decisions (confirmed with user)

1. **Presign = capability-detect.** Methods exist only when the backend signs.
   S3/R2 → present; filesystem → absent. Matches the port's "optional means
   unsupported" rule.
2. **Conformance target = filesystem adapter** (`files-sdk/fs`) in a tmpdir —
   credential-free, runs in CI like `FsFileStore`'s unit test.
3. **Edge-safe bridge, Node host now.** Implement the Node `Readable`/`Buffer`
   port, but isolate the Web-stream conversion (`toWeb`/`fromWeb`) so an
   `EdgeRestApplication`-native variant is a localized follow-up.

## Out of scope (prototype)

`copy`/`move`/`list`/`search`, byte-range, resumable uploads, plugins — present
in `files-sdk` but deliberately not projected onto the port (no port widening).
Edge-native byte path is a follow-up. Broader doc-surface sweep (`docs/packages.md`,
the agent skill, `CLAUDE.md` capability list, an `examples/hello-*`) is deferred
until the prototype is accepted.

## Dependency posture

`files-sdk` is a **peerDependency** (`^2.0.0`) + devDependency for this package's
own tests — mirroring how `files-s3` relates to the AWS SDK. Each `files-sdk`
adapter pulls its own provider peer deps; the fs adapter needs none.

## Follow-up: `stat()` adopted into the port (2026-06-22)

Of the `files-sdk` surface, **`head` (metadata without body)** was the one real
gap in the port — `fileDownload` previously called full `get()` even when a
handler only needed size/contentType. Added `stat(key): Promise<FileMetadata>`
to `FileStore` and a new `FileMetadata` interface (`RetrievedFile` now
`extends FileMetadata`, adding optional `etag`/`lastModified`). Implemented on
all four adapters — in-memory (map entry), fs (`fsStat` + sidecar), S3
(`HeadObjectCommand`), files-sdk (`files.head`) — and gated by a new conformance
case. `list`/`search`/`copy`/`move`/bulk/progress/plugins were declined (app-DB
layering or framework features AgentBack already provides).

## Validation

`pnpm -F @agentback/files-sdk build` clean; the package's unit suite (4
conformance cases + 3 specifics: filename/metadata round-trip, presign-absent on
fs, prefix scoping) is **7/7 green**.
