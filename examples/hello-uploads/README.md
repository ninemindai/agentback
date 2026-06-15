# hello-uploads

First-class **file upload + download** on AgentBack's schema-first routing.

A single `fileField()` on the upload route's `body:` schema drives everything:

- the per-route **multipart parser** (streams each file to the bound
  `FileStore` under a server-generated UUID key — never the client filename),
- **runtime validation** (size / mime via the same schema),
- the **OpenAPI** contract (`multipart/form-data`, `file` as `format: binary`),
  so the upload route shows up in `/openapi.json` and `/llms.txt`.

Downloads `return fileDownload(...)`, which `RestServer` streams to the
response (`Content-Type` / `Content-Disposition`) instead of JSON-encoding.

## Run

```bash
pnpm -F hello-uploads start
# upload (multipart), identify the caller with x-user-id:
curl -F file=@./photo.png -F label=avatar -H 'x-user-id: alice' http://127.0.0.1:3000/files
# list your files:
curl -H 'x-user-id: alice' http://127.0.0.1:3000/files
# download (owner only):
curl -H 'x-user-id: alice' http://127.0.0.1:3000/files/<id> -o out.bin
```

## Security

The two issues dapp5's file recipe left `FIXME`:

- **No key traversal** — storage keys are server-generated UUIDs from the
  parser, never a client-controlled path.
- **Ownership enforced** — every read checks the file's owner against the
  caller; cross-owner reads are `403`.

## Production swaps (controller unchanged)

- `InMemoryFileStore` → `S3FileStore` from `@agentback/files-s3`
- `FileMetaStore` (a `Map`) → a Drizzle `files` table (`@agentback/drizzle`)
- the `x-user-id` header → a real principal via `@authenticate` +
  `SecurityBindings.USER`
