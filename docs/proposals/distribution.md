# Proposal P1-8: Distribution — one app, every install path

**Status:** Design, revised after review (2026-10-02). Not scheduled. Filed
after P1-7 phase 1a, as [host extensions §12](host-extensions.md#12-out-of-scope)
planned.
**Packages touched:**

- `cli` — a new `pack` command, beside `new`, `deploy` and `update`;
- `mcp` — one public accessor and a static `describeServer()`;
- `create-agentback` — a `buildApp` export in every template, and an opt-in
  `distribution` capability;
- docs.

**Builds on:** [host extensions](host-extensions.md) (server identity, icons,
`installSettings`), [CLI lifecycle](cli-lifecycle.md) (the `agentback` bin and
its entry convention), [P1-5 skill generation](p1-5-skill-generation.md).

---

## 1. Context

An AgentBack MCP app reaches a user in one of four ways. The framework helps
with one of them today:

| Path                       | What the user does                                                             | What the author ships                                                     | AgentBack today                                   |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| **Remote connector**       | Pastes an HTTPS URL into Claude (Customize → Connectors) or adds a ChatGPT app | A deployed `/mcp` endpoint (OAuth when it is per-user)                    | `installMcpHttp` + `agentback deploy` + checklist |
| **Claude plugin**          | `/plugin install name@marketplace`, or Customize → Plugins on claude.ai        | A directory: `.claude-plugin/plugin.json`, `.mcp.json`, `skills/`, assets | nothing                                           |
| **Codex plugin**           | Installs from a marketplace in Codex                                           | A directory: `.codex-plugin/plugin.json`, `.mcp.json`, `skills/`          | nothing                                           |
| **Local bundle (`.mcpb`)** | Drags a file into Claude Desktop (Settings → Extensions)                       | A zip: `manifest.json`, the server, its dependencies                      | nothing                                           |

**ChatGPT apps are remote-only**: a ChatGPT user reaches an app through its
URL, so for ChatGPT the remote connector is the whole story. The Codex plugin
is a separate path for OpenAI's coding surfaces.

Plugins are where "how users actually find an app" is decided: a plugin
carries **skills** (including OpenAI's `onboardingSkill`) and directory
metadata, and it can wrap a remote endpoint as easily as a local command. A
bundle is the only one-click local install Claude Desktop offers. Every path
needs the same facts — name, title, version, description, icons, how to reach
the server, its tools — in a different file format.

### The formats (read from primary sources on 2026-10-02)

- **MCP Bundles** ([modelcontextprotocol/mcpb](https://github.com/modelcontextprotocol/mcpb)):
  - `manifest.json` at the root, `manifest_version: "0.3"` (the `latest`
    schema; `"0.4"` only adds `server.type: "uv"`).
  - Required: `name`, `version`, `description`, `author.name`, and
    `server: {type, entry_point, mcp_config: {command, args, env}}`, with
    `${__dirname}` / `${user_config.KEY}` substitution.
  - Optional: `display_name`, `icon`/`icons[]`, `tools[{name, description}]`,
    `prompts`, `user_config` (`string|number|boolean|directory|file`;
    `sensitive` for secrets), `compatibility` (`platforms`, `runtimes.node`).
  - CLI: `mcpb validate | pack | sign`. Installed by Claude Desktop; a Claude
    Code plugin may also reference a `.mcpb`.
- **Claude plugins** ([plugins reference](https://code.claude.com/docs/en/plugins-reference),
  [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference)):
  - `.claude-plugin/plugin.json`: only `name` is required. Optional fields
    include `displayName`, `version`, `description`, `author`, `icon`,
    `homepage`, and `userConfig`, whose `sensitive` values go to the OS
    credential store.
  - Components by convention: `skills/<name>/SKILL.md`, and `.mcp.json` with
    `${CLAUDE_PLUGIN_ROOT}` for a local command or a URL for a remote server.
  - Marketplace: `.claude-plugin/marketplace.json` (`name`, `owner.name`,
    `plugins[{name, source}]`).
  - One format installs into Claude Code and, via Customize → Plugins, into
    claude.ai and Desktop. A plugin with a top-level `bin/` is not installed
    there.
- **Codex plugins** ([openai/plugins](https://github.com/openai/plugins); the
  [bits-and-bolts example](https://github.com/openai/mcp-extensions/tree/main/plugins/bits-and-bolts)):
  - `.codex-plugin/plugin.json` with `name`, `version`, `description`,
    `author`, `skills`, `mcpServers: "./.mcp.json"`, an `interface` block
    (`displayName`, `shortDescription`, `longDescription`, `developerName`,
    `category`, `capabilities[]`, `logo`, `logoDark`, `composerIcon`,
    `defaultPrompt[]`) and `extensions["com.openai"].onboardingSkill`.
  - Marketplace: `.agents/plugins/marketplace.json`.
  - **Field semantics are shown by example, not documented.** Search results
    suggest a move to a root `plugin.json`, which could not be confirmed (D1).
  - OpenAI's example ships one esbuild-bundled `dist/server.js` with no
    `node_modules`.

## 2. Principles

1. **The app is the source.** Every manifest field the app already declares —
   server name, title and icons, the served `@tool` list, an advertised
   settings capability — is read from the app. Version, description, author
   and the Node floor come from `package.json`, which is already the
   publishing source of truth. Nothing is retyped into a JSON file; a second
   copy is the drift [agent-ergonomics](../agent-ergonomics.md) warns about.
2. **Generate, don't template.** `pack` writes manifests into an output
   directory on every run; nothing generated is committed or hand-edited.
   Author-owned content (skills, a pack config, extra assets) is copied in.
3. **One entry convention.** `pack` loads the app exactly the way `deploy`
   does: the same `buildApp` export and the same `--entry/--export`
   overrides.
4. **The host's own tools stay authoritative.** `pack` validates against the
   format's published schema and never re-implements signing (`mcpb sign`) or
   publishing.
5. **No secret ships by accident.** The bundle is built from an allowlist,
   and the stage is scanned for secrets by name **and** content before it is
   archived.
6. **Unstable formats stay behind a flag.** The Codex target is experimental
   until OpenAI documents its manifest.

## 3. Design

### 3.1 Reading the app: `describeServer()`

```ts
// @agentback/mcp
describeServer(server: MCPServer): ServerDescription
// {name, title?, icons?, websiteUrl?,
//  tools: [{name, title?, description?, ui?: {resourceUri?}}],
//  prompts: [{name, description?}],
//  capabilities: {extensions?, experimental?},
//  transports: {stdio: boolean}}
```

- **Built on what already works before `start()`:** `servedTools()` (not
  `listTools()`, which can list a class registered twice — the hybrid
  template registers its dual class as a controller and a service),
  `listPrompts`, and `advertisedCapabilities()`.
- **One new public accessor**, `MCPServer.serverInfo()`. The info is private
  today.
- **No host vocabulary in `mcp`.** A settings capability is found
  structurally by the caller, as an `extensions` entry with
  `readTool`/`updateTool`. `describeServer` itself knows nothing about
  `openai/settings`.
- **`description` is not on `MCPServerConfig`**; `pack` takes it from
  `package.json`.

**Loading the app — the version-skew trap.** `pack` runs from
`npx @agentback/cli@latest`, which is not the app's copy of `@agentback/mcp`.
Importing `describeServer` from the CLI's own copy breaks class identity and
DI metadata, and fails outright on an app older than the helper. So `pack`:

1. Resolves the builder exactly like `deploy`: `resolveBuilder` in
   `packages/cli/src/detect.ts` probes `dist/main.js` / `dist/index.js` for
   `buildApp`, honours `--entry/--export`, and calls it **without
   `start()`**.
2. Resolves `@agentback/mcp` **from the app's root**
   (`createRequire(projectRoot)`). It feature-detects `describeServer` and
   says which version introduced it when it is missing.
3. Fetches the server by the string key `'servers.MCPServer'`.

**Templates.** No template exports a builder today. The `mcp` and `hybrid`
templates split construction (`src/application.ts`) from serving
(`src/main.ts`), but `main.ts` installs transports at the top level and
exports nothing. Examples such as `hello-mcp-apps` build in a function inside
`server.ts`. The same gap already limits `agentback deploy` on a fresh
scaffold. Phase 1 adds
`export async function buildApp()` to every template's `main.ts`, covering
the tool and `installSettings` registrations, and documents the requirement.
Building must be free of side effects (no listen, no network); an app whose
build reaches the network is a bug `pack` surfaces with a timeout, not one it
causes.

### 3.2 `agentback pack <target>`

```bash
agentback pack claude-plugin --remote https://app.example.com/mcp   # phase 1
agentback pack claude-plugin                                         # local command
agentback pack mcpb
agentback pack codex-plugin   # experimental
```

Shared steps, in order:

1. **Fresh-build check.** Refuse when `dist/` is older than `src/`.
2. **Describe** (§3.1).
3. **Bundle** — local targets only. The default is an **esbuild
   single-file** server (`dist-pack/server.js`), built with the CLI's
   existing esbuild and `bundle-doctor`, which already resolves lazily
   imported optional peers. It needs no lockfile and no `node_modules`, and
   works whatever the app's package manager or `workspace:` ranges.
   `--no-bundle` copies the build output plus a production `node_modules`
   instead, for a server whose native modules cannot be bundled.
4. **Stage** the allowlist: the bundle, declared assets
   (`agentback.pack.include` in `package.json`) and `skills/**`.
5. **Scan for secrets.** Refuse on names — `.env*`, `.npmrc`, `*.pem`,
   `*.key`, `*.p12`, `*.pfx`, `id_*`, `*.db`, `*.sqlite`, and
   `@agentback/config` files (`config/*.{json,jsonc,yaml,yml}`). Then scan
   content for known token prefixes and high-entropy strings, which catches
   an env value inlined into the bundle. A finding aborts the pack and names
   the file; `--allow-file <path>` is the per-file escape hatch.
6. **Emit, then validate** each manifest against the format's published JSON
   Schema (vendored, with its version recorded), plus `mcpb validate` when it
   is on `PATH`.
7. **Archive** (`.mcpb` only).

Per target:

| Field           | Claude `plugin.json` (+ `.mcp.json`)                                                                                                                   | `.mcpb` `manifest.json`                        | Codex `plugin.json` (experimental)               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------ |
| id              | `name` ← server name                                                                                                                                   | `name`                                         | `name`                                           |
| display name    | `displayName` ← server `title`                                                                                                                         | `display_name`                                 | `interface.displayName`                          |
| version         | `package.json` `version` (warns if the server config disagrees)                                                                                        | same                                           | same                                             |
| description     | `package.json` `description`                                                                                                                           | same                                           | `interface.shortDescription`                     |
| icon            | `icon` ← local file, or a `data:` server icon written to disk                                                                                          | `icons[]` (same source)                        | `interface.logo` / `logoDark`                    |
| how to reach it | **remote:** `{"type": "http", "url": …}` · **local:** `node ${CLAUDE_PLUGIN_ROOT}/server.js`                                                           | `node ${__dirname}/server.js`                  | local command in `.mcp.json`                     |
| auth            | **remote:** OAuth discovered by the host from the server's protected-resource metadata (what `installMcpHttp({auth})` serves); no secret in the plugin | none (local process)                           | as Claude                                        |
| runtime         | —                                                                                                                                                      | `compatibility.runtimes.node` ← `engines.node` | —                                                |
| tools           | —                                                                                                                                                      | `tools[]` ← served tools                       | —                                                |
| user secrets    | `userConfig` (`sensitive`) ← `agentback.pack.userConfig`                                                                                               | `user_config` (`sensitive`), same source       | —                                                |
| skills          | `skills/` copied, tool names checked                                                                                                                   | —                                              | `skills/` copied; `onboardingSkill` when present |

**Paths.** Launch paths in a manifest are written as POSIX strings after the
host's variable (`${__dirname}/server.js`), never with `path.join`, so a pack
built on Windows still runs elsewhere and the other way round.

**Node runtime.** Templates require Node `>=22.18`. The bundle declares that
floor from `engines.node`, and the docs note that the Node a host ships may
be older than the app needs.

**`.mcpb` refuses what will not work.** `pack mcpb` stops with an
explanation when:

- the server does not serve stdio (`transports.stdio: false`, as in the
  `hybrid` template), since a bundle is a stdio launch;
- any served tool links a widget (`ui.resourceUri`), because Claude Desktop
  currently drops `_meta.ui` for stdio servers
  ([host extensions Q5](host-extensions.md#11-open-questions)). An app with
  widgets should ship as a remote connector or a remote plugin.

`--force` overrides the widget check, for when the host bug is fixed.

**User config.** A local server's secrets come from the user at install time.
`agentback.pack.userConfig` maps an env var the app reads to a
`userConfig`/`user_config` entry, for example `{env: 'WEATHER_API_KEY', title:
'Weather API key', sensitive: true}`. It is emitted into the launch `env` as
`${user_config.weather_api_key}`. `pack` never embeds a value. Deriving the
map from `@agentback/config`'s schema is phase 5.

### 3.3 Skills and onboarding

Plugins are how skills ship. `pack` copies `skills/**` verbatim; the author
owns them. [P1-5](p1-5-skill-generation.md)'s `generateSkill()` (a draft, not
implemented) would derive an app skill's reference layer from the registry —
once it ships, `pack` emits that skill too, and the author keeps only the
procedural layer. Until then:

- `create-agentback --with distribution` scaffolds `skills/<app>/SKILL.md`
  (what the app is for, its tools by name). When the app uses
  `installSettings`, it also scaffolds `skills/onboarding/SKILL.md`, which
  walks the user through `settings_read` / `settings_update` — the pattern
  OpenAI's example uses. Both are scaffolded once; the author owns the text
  afterwards.
- `pack codex-plugin` sets `extensions["com.openai"].onboardingSkill` when
  `skills/onboarding/SKILL.md` exists.
- **Tool-name check.** Every backticked name in a shipped `SKILL.md` that
  matches a tool-name shape is checked against the served tools, and a miss
  warns. A renamed tool otherwise leaves a skill silently wrong.

### 3.4 Marketplaces

`agentback pack --marketplace <dir>` writes `.claude-plugin/marketplace.json`
(and, experimentally, `.agents/plugins/marketplace.json`) listing the packed
plugin with a relative `source`, for a repository that is itself the
marketplace. Publishing to a directory (Claude's Connectors Directory, a
ChatGPT listing) is out of scope (§9).

## 4. Security

- **Allowlist staging plus a name-and-content secret scan** (§3.2 steps 4–5).
  The content scan exists because a bundler inlines what it imports,
  including a config value read at module load.
- **A remote plugin carries no credentials.** Auth is the host's OAuth flow
  against the server's protected-resource metadata.
- **`sensitive` user config** for every mapped secret; the host stores the
  value (Claude: the OS credential store).
- **Signing** stays with `mcpb sign`; `pack` prints the command.
- **A bundle runs with the user's privileges.** It is the case
  `resourcePath`'s `allowHttp: false` default
  ([host extensions §9](host-extensions.md#9-security)) is built for — a
  local server reading local paths.

## 5. Phasing

1. **`describeServer` + `buildApp` in the templates + `pack claude-plugin
--remote`.** The smallest useful slice: listing metadata and skills around
   an endpoint the author already deploys. No bundling, no secrets, no
   runtime question. Includes the skill tool-name check and `--marketplace`.
2. **`pack claude-plugin` (local) and `pack mcpb`.** esbuild bundling, the
   secret scan, schema validation, and the stdio/widget refusals.
3. **`create-agentback --with distribution`** (skill and onboarding stubs).
4. **`pack codex-plugin`** (experimental). Promoted when OpenAI documents the
   manifest (D1).
5. **`userConfig` from `@agentback/config`.** Derive the env map from the
   app's config schema instead of declaring it.

## 6. Testing

- **Golden manifests** per target for a fixture app, validated against the
  vendored schemas in CI.
- **Version skew:** `pack` from the current CLI against a fixture app pinned
  to an older `@agentback/mcp` fails with the named minimum version and does
  not throw a class-identity error.
- **Secret scan:** each refused name, and a token inlined into the bundle,
  aborts the pack; `--allow-file` admits exactly one file.
- **Refusals:** a non-stdio server and a widget tool both stop `pack mcpb`.
- **Round trip (manual, recorded in the PR):** install the phase-1 remote
  plugin in Claude Code and on claude.ai, and a phase-2 `.mcpb` in Claude
  Desktop.

## 7. Documentation surfaces (acceptance criteria)

Per CLAUDE.md, landing with each phase:

- `packages/cli/README.md` and `skills/agentback/references/cli.md` (`pack`);
- a guide, `docs/guides/distribution.md`, linked from `docs/README.md`;
- `docs/guides/mcp-apps-widgets.md` (the widget/stdio refusal and the remote
  plugin);
- `packages/create-agentback/README.md` (`buildApp`, `--with distribution`);
- CLAUDE.md (`cli` entry);
- the release notes.

## 8. Open questions

| #   | Question                                                                              | How it closes                                                                                |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| D1  | Does OpenAI's packaging move to a root `plugin.json` with `extensions["com.openai"]`? | Read the developers.openai.com plugin docs (blocked from this session); gate phase 4 on it   |
| D2  | `.mcpb` `manifest_version`: `0.3` (the `latest` schema) or `0.4`?                     | Emit `0.3` (Node needs no `uv`); revisit when `latest` moves                                 |
| D3  | ~~Construct the app in `pack`, or have apps emit their own description?~~             | **Closed:** reuse `deploy`'s `buildApp` convention and resolve `@agentback/mcp` from the app |
| D4  | Does an esbuild single file cover typical apps?                                       | Measure on `hello-mcp-apps` and the templates in phase 2; `--no-bundle` is the fallback      |
| D5  | Can one directory serve Claude and Codex at once (both manifests side by side)?       | Both read `.mcp.json` and `skills/`; test install in both in phase 4                         |
| D6  | How does a remote `.mcp.json` entry express a header-based (non-OAuth) API key?       | Claude's request-header connector auth is in beta; follow it before emitting one             |

## 9. Out of scope

- Publishing to any store or directory, listing review, and auto-update.
- Python or binary servers.
- Hosting: `agentback deploy` already covers Vercel and Cloudflare.
- Widget-side code ([host extensions §12](host-extensions.md#12-out-of-scope)).

## Review record (2026-10-02)

A three-lens review (product, engineering, DX) of the first draft changed
the design:

- **Phase 1 became the remote Claude plugin.** It needs no bundling and is
  the path widget apps can actually use.
- **App loading reuses `deploy`'s `buildApp` entry convention** and the
  app's own `@agentback/mcp`. The draft's separate `agentback.app` key and
  CLI-side import would have broken on version skew.
- **Staging defaults to an esbuild single file**, as OpenAI's example does.
  `pnpm deploy` / `npm ci` fail without a lockfile or on `workspace:` ranges.
- **`describeServer` uses `servedTools()`** and a new public `serverInfo()`;
  `description` comes from `package.json`.
- **`pack mcpb` refuses non-stdio servers and widget apps** (host extensions
  Q5).
- **New:** the remote-auth row, POSIX launch paths, the Node floor from
  `engines`, a wider secret scan with a content pass, `data:` icons,
  ChatGPT-vs-Codex separated, and Testing and Documentation sections.
