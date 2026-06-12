# Plan 002: Sanitize internal 5xx error messages in REST, MCP, and streams

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report; do not improvise. When done, update the status row for this plan in
> `plans/README.md` unless a reviewer dispatched you and told you they maintain
> the index.
>
> **Drift check (run first)**:
> `git diff --stat 3acdb66..HEAD -- packages/openapi/src/agent-error.ts packages/rest/src/rest.server.ts packages/rest/src/__tests__/integration/rest-server.integration.ts packages/rest/src/__tests__/integration/sse.integration.ts packages/rest/src/__tests__/integration/jsonl.integration.ts packages/mcp/src/mcp.server.ts packages/mcp/src/__tests__/unit/agent-contract.unit.ts`
>
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `3acdb66`, 2026-06-11

## Why this matters

The framework promises machine-actionable errors and tells agents to use stable
`code` fields instead of parsing `message`. Today raw thrown messages are still
returned for default 500 errors and mid-stream failures. App code can throw
messages containing internal state, dependency details, or secrets. This plan
keeps helpful public messages for intentional 4xx and explicit framework
errors, while hiding accidental internal 5xx messages behind a generic response.

## Current state

- `packages/openapi/src/agent-error.ts` builds the shared REST/MCP error
  envelope.
- `packages/rest/src/rest.server.ts` returns that envelope for normal REST
  errors and writes stream error frames after headers have flushed.
- `packages/mcp/src/mcp.server.ts` uses the same envelope for MCP tool errors.
- Existing stream tests currently assert that `Error('boom mid-stream')` is
  visible to clients.

Relevant excerpts at plan time:

```ts
// packages/openapi/src/agent-error.ts:171
const statusCode = e.status ?? e.statusCode ?? fallbackStatus;
const code = e.code ?? codeForStatus(statusCode);
const issues = e.issues ?? e.details;
return {
  statusCode,
  code,
  message: e.message ?? 'Internal Server Error',
  ...
};
```

```ts
// packages/rest/src/rest.server.ts:601
} catch (err) {
  const e = err as Error;
  log.debug('stream handler threw mid-stream: %s', e.message);
  if (!closed) {
    res.write(
      framer.error({statusCode: 500, message: e.message ?? 'stream error'}),
    );
  }
}
```

```ts
// packages/mcp/src/mcp.server.ts:845
} catch (error) {
  const {statusCode: _statusCode, ...envelope} =
    buildErrorEnvelope(error);
  return {
    content: [{type: 'text' as const, text: JSON.stringify({error: envelope})}],
    isError: true,
  };
}
```

Existing tests to update:

```ts
// packages/rest/src/__tests__/integration/sse.integration.ts:116
it('mid-stream errors become an event: error frame, never a crash', async () => {
  ...
  expect(fs[1]).toContain('boom mid-stream');
});
```

```ts
// packages/rest/src/__tests__/integration/jsonl.integration.ts:106
it('mid-stream errors become a trailing error line, never a crash', async () => {
  ...
  expect(last.error.message).toBe('boom mid-stream');
});
```

Repo conventions to follow:

- Keep the error envelope shape: `{error: {statusCode, code, message, ...}}`.
- Validation errors must remain detailed and retryable.
- Public `http-errors` 4xx messages should remain visible.
- Log internal details with `loggers`; do not return them to callers.

## Commands you will need

| Purpose             | Command                                                                                                                                                                                                              | Expected on success     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Build               | `pnpm build`                                                                                                                                                                                                         | exit 0                  |
| Targeted REST tests | `pnpm exec vitest run packages/rest/dist/__tests__/integration/rest-server.integration.js packages/rest/dist/__tests__/integration/sse.integration.js packages/rest/dist/__tests__/integration/jsonl.integration.js` | all selected tests pass |
| Targeted MCP tests  | `pnpm exec vitest run packages/mcp/dist/__tests__/unit/agent-contract.unit.js`                                                                                                                                       | all selected tests pass |
| Full tests          | `pnpm test`                                                                                                                                                                                                          | exit 0                  |
| Lint                | `pnpm lint`                                                                                                                                                                                                          | exit 0                  |

Important: run `pnpm build` before Vitest because tests execute from `dist`.

## Scope

**In scope**:

- `packages/openapi/src/agent-error.ts`
- `packages/rest/src/rest.server.ts`
- `packages/rest/src/__tests__/integration/rest-server.integration.ts`
- `packages/rest/src/__tests__/integration/sse.integration.ts`
- `packages/rest/src/__tests__/integration/jsonl.integration.ts`
- `packages/mcp/src/mcp.server.ts` only if the shared helper is insufficient
- `packages/mcp/src/__tests__/unit/agent-contract.unit.ts`

**Out of scope**:

- Changing validation issue shape.
- Changing 401/403/404 client-visible messages.
- Adding environment-specific debug response modes.
- Rewriting the stream framing format.

## Git workflow

- Branch: `advisor/002-sanitize-error-envelopes`
- Commit message style: conventional commits, e.g.
  `fix(rest): sanitize internal error envelopes`.
- Do not push or open a PR unless the operator explicitly asks.

## Steps

### Step 1: Centralize public message selection

In `packages/openapi/src/agent-error.ts`, add a small helper used by
`buildErrorEnvelope` to choose the client-visible message.

Required behavior:

- If `statusCode >= 500` and the thrown error does not carry an explicit
  public/safe marker, return `'Internal Server Error'`.
- If `statusCode < 500`, preserve the current message behavior.
- Preserve framework-authored machine-actionable messages where they are
  intentional and status is not an accidental 500.
- Introduce an explicit opt-in field for rare safe 5xx messages, for example
  `publicMessage?: string` or `exposeMessage?: true`. Prefer `publicMessage`
  because it avoids returning an arbitrary `Error.message`.
- Do not include the raw message anywhere else in the returned envelope.

Update the local type in `buildErrorEnvelope` so TypeScript understands the new
field.

**Verify**: `pnpm build` -> exit 0.

### Step 2: Add REST non-stream regression coverage

In `packages/rest/src/__tests__/integration/rest-server.integration.ts`, add a
controller route for an accidental `throw new Error('database password leaked')`
or similarly obvious internal text. Add an integration test proving:

- HTTP status is 500.
- `body.error.code` is `internal_error`.
- `body.error.message` is exactly `'Internal Server Error'`.
- The raw thrown text is not present in `JSON.stringify(body)`.

Also add or preserve coverage that an intentional 4xx, such as unknown route or
`createError(404, 'no such stream')`, still exposes its public message.

**Verify**:
`pnpm build && pnpm exec vitest run packages/rest/dist/__tests__/integration/rest-server.integration.js`
-> all tests in that file pass.

### Step 3: Sanitize post-flush stream errors

In `packages/rest/src/rest.server.ts`, keep logging the raw stream error at
debug level, but write a sanitized envelope/frame for mid-stream exceptions.
The simplest acceptable implementation is to call `buildErrorEnvelope(err)` and
then force the public message to generic for 5xx, or call a new exported helper
from `agent-error.ts` if you created one.

Update `sse.integration.ts` and `jsonl.integration.ts`:

- Mid-stream thrown `Error('boom mid-stream')` should still produce an error
  event/line and terminate cleanly.
- The client-visible message should be `'Internal Server Error'`.
- The raw text `'boom mid-stream'` must not appear in the stream body.
- Response-validation errors may keep a framework-authored message such as
  `'Stream item failed response validation.'` if you mark it as public, or may
  also become generic if that is the chosen policy. Be consistent and update
  tests accordingly.

**Verify**:
`pnpm build && pnpm exec vitest run packages/rest/dist/__tests__/integration/sse.integration.js packages/rest/dist/__tests__/integration/jsonl.integration.js`
-> pass.

### Step 4: Add MCP regression coverage

In `packages/mcp/src/__tests__/unit/agent-contract.unit.ts`, add a tool that
throws an accidental `Error('internal token leaked')` without status/code. Use
the existing in-memory MCP client helper. Assert:

- `callTool` returns `isError: true`.
- The parsed envelope has `code === 'internal_error'`.
- The envelope message is `'Internal Server Error'`.
- The raw thrown text is not present in the tool result text.

Keep the existing invalid-input test detailed; validation errors must still
include `issues`, `schema`, and the remediation hint.

**Verify**:
`pnpm build && pnpm exec vitest run packages/mcp/dist/__tests__/unit/agent-contract.unit.js`
-> pass.

### Step 5: Run full verification

Run:

```bash
pnpm build
pnpm test
pnpm lint
```

Expected: all exit 0.

## Test plan

- New REST test for accidental non-stream 500 sanitization.
- Updated SSE and JSONL tests for sanitized mid-stream failures.
- New MCP test for accidental tool 500 sanitization.
- Existing invalid input and public 4xx tests must continue to pass.

## Done criteria

- [ ] Accidental REST 500 responses do not expose raw `Error.message`.
- [ ] Accidental MCP tool errors do not expose raw `Error.message`.
- [ ] Accidental SSE/JSONL mid-stream errors do not expose raw `Error.message`.
- [ ] 4xx and validation envelopes remain machine-actionable.
- [ ] Targeted REST and MCP tests pass from `dist`.
- [ ] `pnpm build`, `pnpm test`, and `pnpm lint` exit 0.
- [ ] `git diff --stat` shows no files outside this plan's in-scope list.

## STOP conditions

Stop and report if:

- The current code no longer matches the excerpts above.
- Sanitizing messages requires changing the public envelope shape or removing
  `code`, `issues`, `schema`, `retryable`, or `hint`.
- You find existing tests or docs requiring arbitrary 5xx messages to be
  public API.
- Verification fails twice after a reasonable fix attempt.

## Maintenance notes

Reviewers should look for accidental raw-message paths outside
`buildErrorEnvelope`, especially stream code that writes after headers flush.
Future framework-authored errors that need public 5xx messages should use the
new explicit safe-message mechanism rather than relying on `Error.message`.
