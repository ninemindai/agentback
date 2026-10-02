// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Typed adapters for OpenAI's MCP extensions (ChatGPT), on top of the
 * generic, checked seams in `@agentback/mcp`. See
 * docs/proposals/host-extensions.md §8.
 *
 * @packageDocumentation
 */

export {
  fileEntrypoint,
  FileEntrypointIn,
  globalEntrypoint,
  openaiUi,
  settingsEntrypoint,
  threadEntrypoint,
  type OpenAIDisplayMode,
  type OpenAIEntrypoint,
  type OpenAIQuickAction,
  type OpenAIUiOptions,
} from './entrypoints.js';
export {
  MentionResource,
  MentionResourceLink,
  mentionSearch,
  MentionSearchIn,
  MentionSearchOut,
} from './mentions.js';
export {displayModes} from './display-modes.js';
export {
  choiceField,
  openaiForm,
  resourceField,
  textField,
  type OpenAIFormField,
  type OpenAIOption,
  type OpenAIResourceOption,
} from './forms.js';
export {resourcePath, type ResourcePathOptions} from './resource-path.js';
export {
  InMemorySettingsStore,
  installSettings,
  SETTINGS_IDENTITY_REQUIRED,
  type InstallSettingsOptions,
  type SettingsGroup,
  type SettingsStore,
} from './settings.js';
export {
  OPENAI_EXTENSIONS_META_KEY,
  OPENAI_RESOURCE_META_KEY,
  OPENAI_SETTINGS_CAPABILITY,
  OPENAI_UI_META_KEY,
} from './shared.js';
