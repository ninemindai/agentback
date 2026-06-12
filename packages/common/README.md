# @agentback/common

> Shared utilities for AgentBack packages and applications: structured logging, concurrency helpers, env access, and debugging.

This package is the lowest-level utility leaf in the workspace. It carries no
DI dependency and can be imported by framework packages and application code
alike.

## What it provides

- **`loggers(namespace)`** — returns a `{error, warn, info, debug, trace}` record of `debug`-compatible loggers, routing to pino when `PINO_LOGGER=1`, otherwise to the `debug` module with optional log hooks.
- **`debugFactory(namespace)`** — single-level logger factory underlying `loggers`.
- **`onLog(hook)`** — register a `(namespace, level, args) => void` hook fired on every `warn`/`error` log; returns a dispose function.
- **`pMap(input, mapper, opts?)`** — concurrency-capped async map (default `concurrency: 5`), wrapping `p-map`.
- **`pMapByPage`** / **`pMapByRange`** / **`pMapByPageOffsetAndLimit`** — paginated async-map helpers for large collections.
- **`fetchIterator`** / **`fetchIteratorByPage`** / **`fetchIteratorByBatch`** — async generator utilities for cursor-based pagination.
- **`getEnv()`** / **`getEnvVar(key, fallback?)`** / **`getEnvVarAsNumber`** — env access with `dotenv` auto-load on first use.
- **`generateId()`** — `nanoid`-backed unique ID generator.
- **`maskSecret(value)`** — redact sensitive strings in logs.
- **`promiseTimeout(ms, promise)`** — race a promise against a timeout.
- **`getServerUrl(req)`** — derive a canonical server URL from an Express request.

## Usage

```ts
import {loggers, pMap, getEnvVar, onLog} from '@agentback/common';

const {info, warn, error} = loggers('myapp:worker');

// Wire a log hook (e.g. to emit Slack alerts on errors)
const dispose = onLog((ns, level, args) => {
  if (level === 'error') alerting.send(ns, args);
});

// Concurrency-capped mapping
const results = await pMap(items, async item => processItem(item), {
  concurrency: 3,
});

// Env access
const apiKey = getEnvVar('OPENAI_API_KEY');
```

## Layering

No `@agentback/*` dependencies. Foundation utility leaf for shared logging,
environment access, ID generation, redaction, and concurrency helpers.
