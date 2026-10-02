# @agentback/mcp-openai

Typed adapters for [OpenAI's MCP extensions](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)
(ChatGPT), built on the generic, checked seams of `@agentback/mcp`
(`toolFragment`, `resourceFragment`, `contributeCapabilities`,
`MCPBindings.REQUEST_META`). Every host rule is checked when the decorator is
applied, so a broken one fails at the decorator line instead of in ChatGPT.

**Experimental:** it tracks OpenAI's spec (0.1.x, checked against commit
`900032d`), so shapes may change in a minor release.

## Exports

| Export                                                                                                                         | Emits / does                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openaiUi({entrypoints?, preferredModelDisplayMode?})`                                                                         | tool `_meta["openai/ui"]`. Checks: linked widget; `{}` accepted (global, thread, settings) or `FileEntrypointIn` (file); one per type; warns without `icons`                                       |
| `globalEntrypoint({quickAction?})`, `threadEntrypoint()`, `settingsEntrypoint({searchTerms?})`, `fileEntrypoint({extensions})` | one-entrypoint shorthands for `openaiUi` (combine several in one `openaiUi`)                                                                                                                       |
| `FileEntrypointIn`                                                                                                             | Zod schema of the arguments a file entrypoint opens with                                                                                                                                           |
| `mentionSearch()`, `MentionSearchIn`, `MentionSearchOut`                                                                       | composer @-mention tool: `openai/extensions` marker, `readOnlyHint`, `ui.visibility: ['app']`; checks the input/output shapes                                                                      |
| `displayModes({preferred?, available?})`                                                                                       | widget content-item `_meta["openai/ui"]`; `pip` refused                                                                                                                                            |
| `openaiForm(fields, {required?})`, `textField`, `choiceField`, `resourceField`                                                 | the `extended` form for `elicit.ask` (suggestions, option descriptions, thumbnails, resource picker with the spec's selection/default rules). 2026-era clients declaring `openai/elicitation` only |
| `resourcePath(ctxOrSource, {roots, allowHttp?})`                                                                               | `_meta["openai/resource"].path` from a file-entrypoint call, `realpath`ed and confined to `roots`; refused over HTTP by default                                                                    |
| `installSettings(app, {schema, store, layout?, names?, advertise?, principalKey?, shared?, authorize?})`                       | `settings_read` / `settings_update` tools over a Zod schema + `openai/settings` capability; returns an `Installed`                                                                                 |
| `InMemorySettingsStore`, `SettingsStore`                                                                                       | the settings storage port (bring Redis/DB for production)                                                                                                                                          |

## Usage

```ts
import {z} from 'zod';
import {appResource, mcpServer, tool} from '@agentback/mcp';
import {
  displayModes,
  installSettings,
  InMemorySettingsStore,
  openaiUi,
} from '@agentback/mcp-openai';

@mcpServer()
class Parts {
  @tool('parts_library', {
    title: 'Parts Library',
    output: Library,
    icons: [{src: 'https://bits.example.com/library.svg'}],
    ui: {resourceUri: 'ui://bits/library'},
    extend: [openaiUi({entrypoints: [{type: 'global'}, {type: 'thread'}]})],
  })
  async library() {
    /* … */
  }

  @appResource('ui://bits/library', {
    extend: [
      displayModes({
        preferred: 'fullscreen',
        available: ['inline', 'fullscreen'],
      }),
    ],
  })
  widget() {
    return WIDGET_HTML;
  }
}

const Settings = z.object({
  units: z.enum(['mm', 'in']).default('mm').meta({title: 'Measurement units'}),
});
await installSettings(app, {
  schema: Settings,
  store: new InMemorySettingsStore(),
});
```

## Settings identity

Settings are stored **per verified user** (`isVerifiedPrincipal` from
`@agentback/mcp`): a user an authentication strategy supplied. The default key
never uses:

- a principal synthesized from a token's `clientId` (`isSynthesizedPrincipal`).
  Under OAuth that id names the host application, ChatGPT, which every one of
  its users shares;
- the `anonymous` strategy's `$anonymous` sentinel;
- the `localPrincipal` config fallback, which applies to every caller the
  transport admits.

**A raw OAuth verifier** (`installMcpHttp({auth: {verifier}})`) yields no
user, so every caller is synthesized. Use `strategyAuth`, or read the subject
yourself with `principalKey: (_user, auth) => auth?.extra?.sub as string |
undefined`.

Without a verified user:

- `settings_update` refuses with `settings_identity_required`;
- `settings_read` returns the defaults.

Pass `principalKey(user, auth)` to choose the key yourself, or `shared: true`
for one bucket (a single-user local server).

## Where it sits

`@agentback/mcp` owns the host-neutral seams. This package holds OpenAI's
vocabulary, so a spec change never touches the core. Claude needs no package:
its one convention, the widget `domain`, is a recipe on
`@appResource({domain: fn})`. See
[docs/guides/mcp-apps-widgets.md](../../docs/guides/mcp-apps-widgets.md) and
`examples/hello-mcp-apps`.

## Not covered

- Widget-side helpers (deep links, `ui/message`, model context, file opening).
  These are browser code against the host bridge.
- Plugin packaging and onboarding skills.
- The legacy `openai/elicitation/create` method on 2025 connections.
