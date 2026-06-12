# @agentback/config

> Zod-validated, env-aware config loader — JSONC + YAML files, layered
> environment overlays, and first-class DI bindings.

Not a port. Written specifically for this monorepo to give services a
single, consistent way to load structured configuration. Files live in a
`config/` directory; an environment-specific overlay (`config.<NODE_ENV>.jsonc`)
is deep-merged on top of the base file before Zod validation runs. String
values can embed `${VAR}` and `${VAR:-default}` interpolations, which are
resolved from `process.env` at load time — a missing variable without a
default throws immediately.

## What it provides

**Loading**

- `loadConfigFile(filename, schema)` — load + overlay + env-interpolation +
  Zod validation; throws `ConfigValidationError` on schema failure.
- `loadRawConfigFile(filename)` — load + overlay + env-interpolation without
  schema validation.
- `shallowMergeConfigs(base, overlay)` — two-level merge used internally (and
  available for custom loaders).
- `getConfigDir()` — resolves the config directory from `CONFIG_DIR` /
  `PROJECT_ROOT` env vars or defaults to `{cwd}/config`.
- `getEnv()` — returns `NODE_ENV` or `'development'`.
- `ConfigValidationError` — `ZodError`-carrying error class thrown on invalid config.

**Env-var helpers**

- `resolveEnvVars(str)` — resolve `${VAR:-default}` references in a single string.
- `resolveEnvVarsInObject(obj)` — recursively resolve references in any JSON
  structure.

**Dotenv**

- `loadEnvFiles(options?)` — cascade-load `.env`, `.env.{NODE_ENV}`,
  `.env.local` into `process.env` at startup (existing vars win unless
  `override: true`).

**DI integration**

- `Configuration` — DI-friendly service that calls `loadConfigFile` and binds
  the result to `config.<name>` in the parent `Context`, tagged `'config'` for
  later discovery.
- `ConfigComponent` — plug into an `Application` to register `Configuration`
  and the resolved config dir as `ConfigBindings.CONFIGURATION` /
  `ConfigBindings.CONFIG_DIR`.
- `ConfigBindings` — typed binding keys: `config.dir`, `config.service`.
- `CONFIG_BINDING_TAG` — tag applied to all bindings created via
  `Configuration.bind()`.

**Parsers**

- `parseConfigText(text, ext)` — parse JSONC or YAML text.
- `SUPPORTED_EXTENSIONS` — `['.json', '.jsonc', '.yaml', '.yml']`.

## Usage

```ts
import {z} from 'zod';
import {Application} from '@agentback/core';
import {ConfigComponent, ConfigBindings} from '@agentback/config';

const RedisConfig = z.object({
  host: z.string(),
  port: z.number().int().default(6379),
  password: z.string().optional(),
});

const app = new Application();
app.component(ConfigComponent);

const cfg = await app.get(ConfigBindings.CONFIGURATION);
cfg.bind('redis.jsonc', RedisConfig);
// -> other services can now: @inject('config.redis') redis: z.infer<typeof RedisConfig>

await app.start();
```

**Without the DI layer** (standalone loader):

```ts
import {loadEnvFiles, loadConfigFile} from '@agentback/config';

loadEnvFiles(); // load .env cascade before anything reads env
const cfg = loadConfigFile('redis.jsonc', RedisConfig);
// cfg is typed as z.infer<typeof RedisConfig>
```

Config directory resolution order:

1. `$CONFIG_DIR` (relative to `$PROJECT_ROOT` or cwd)
2. `$PROJECT_ROOT/config`
3. `{cwd}/config`

Overlay merge order (last wins):

```
config/redis.jsonc
config/redis.development.jsonc   ← only when NODE_ENV=development
```

## Layering

Depends on: `@agentback/context`, `@agentback/core`.  
Sit this above `core` and below your domain services. The `ConfigComponent`
needs a running `Application`; standalone loader functions have no framework
dependency.
