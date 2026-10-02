// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Icon} from '@modelcontextprotocol/server';
import {toolFragment, type JsonValue, type ToolFragment} from '@agentback/mcp';
import {z} from 'zod';
import {accepts, warn, nonBlank, OPENAI_UI_META_KEY} from './shared.js';

/**
 * The arguments ChatGPT passes a tool opened through a file entrypoint. Use it
 * (or a schema that accepts it) as the tool's `input:`.
 */
export const FileEntrypointIn = z.object({
  file: z.object({
    /** The opened file's name, extension included, no path. */
    name: z.string().min(1),
    /** Opaque host URI; `resources/read` on it is answered by ChatGPT. */
    resourceUri: z.string().regex(/\S/),
  }),
});

/** A sidebar shortcut invoking a tool of the same app. */
export interface OpenAIQuickAction {
  title: string;
  /** At least one icon. */
  icons: Icon[];
  target: {type: 'tool'; name: string; arguments?: Record<string, JsonValue>};
}

/** One way ChatGPT can open an MCP App without the model. */
export type OpenAIEntrypoint =
  | {type: 'global'; quickAction?: OpenAIQuickAction}
  | {type: 'thread'}
  | {type: 'settings'; searchTerms?: string[]}
  | {type: 'file'; extensions: string[]};

export type OpenAIDisplayMode = 'inline' | 'fullscreen';

export interface OpenAIUiOptions {
  /** At most one entrypoint of each type. */
  entrypoints?: OpenAIEntrypoint[];
  /** The display mode a model-initiated render should prefer. */
  preferredModelDisplayMode?: OpenAIDisplayMode;
}

const FILE_SAMPLE = {
  file: {name: 'sample.ext', resourceUri: 'host-resource://sample'},
};

function entrypointJson(e: OpenAIEntrypoint, i: number): JsonValue {
  const at = `entrypoints[${i}]`;
  switch (e?.type) {
    case 'global': {
      if (!e.quickAction) return {type: 'global'};
      const q = e.quickAction;
      nonBlank(q.title, `${at}.quickAction.title`);
      if (!Array.isArray(q.icons) || q.icons.length === 0) {
        throw new Error(`${at}.quickAction.icons needs at least one icon`);
      }
      if (q.target?.type !== 'tool') {
        throw new Error(`${at}.quickAction.target.type must be 'tool'`);
      }
      nonBlank(q.target.name, `${at}.quickAction.target.name`);
      return {
        type: 'global',
        quickAction: structuredClone(q) as unknown as JsonValue,
      };
    }
    case 'thread':
      return {type: 'thread'};
    case 'settings':
      for (const t of e.searchTerms ?? []) nonBlank(t, `${at}.searchTerms[]`);
      return e.searchTerms
        ? {type: 'settings', searchTerms: [...e.searchTerms]}
        : {type: 'settings'};
    case 'file':
      if (!Array.isArray(e.extensions) || e.extensions.length === 0) {
        throw new Error(`${at}.extensions needs at least one extension`);
      }
      for (const x of e.extensions) {
        if (typeof x !== 'string' || !/^\.\S+$/.test(x.trim())) {
          throw new Error(
            `${at}.extensions entries must be file extensions like '.stl', got ${JSON.stringify(x)}`,
          );
        }
      }
      return {type: 'file', extensions: [...e.extensions]};
    default:
      throw new Error(
        `${at}.type must be 'global', 'thread', 'settings' or 'file'`,
      );
  }
}

/**
 * ChatGPT's tool UI metadata (`_meta["openai/ui"]`): entrypoints that open the
 * tool's MCP App from the sidebar, a thread tab, settings or a file, and the
 * display mode a model-initiated render prefers.
 *
 * Checked when `@tool` is applied:
 * - an entrypoint needs a linked widget (`ui: {resourceUri}`);
 * - `global`, `thread` and `settings` entrypoints are opened with `{}`, so the
 *   tool's `input:` must accept `{}`;
 * - a `file` entrypoint is opened with {@link FileEntrypointIn}, so `input:`
 *   must accept it;
 * - at most one entrypoint of each type.
 *
 * A tool without `icons` gets a warning: ChatGPT shows the icon in navigation.
 * One tool takes one `openaiUi` fragment — combine entrypoints in it rather
 * than passing two (the `openai/ui` key would be set twice).
 *
 * Presentation only: an entrypoint is not authorization.
 *
 * @experimental Tracks OpenAI's MCP extensions spec (0.1.x).
 */
export function openaiUi(options: OpenAIUiOptions): ToolFragment {
  const entrypoints = (options.entrypoints ?? []).map(entrypointJson);
  const types = (options.entrypoints ?? []).map(e => e.type);
  const dup = types.find((t, i) => types.indexOf(t) !== i);
  if (dup) throw new Error(`openaiUi: more than one '${dup}' entrypoint`);
  const mode = options.preferredModelDisplayMode;
  if (mode !== undefined && mode !== 'inline' && mode !== 'fullscreen') {
    throw new Error(
      `openaiUi: preferredModelDisplayMode must be 'inline' or 'fullscreen'`,
    );
  }
  const value: Record<string, JsonValue> = {};
  if (entrypoints.length) value.entrypoints = entrypoints;
  if (mode) value.preferredModelDisplayMode = mode;
  return toolFragment({
    meta: {[OPENAI_UI_META_KEY]: value},
    check: resolved => {
      if (!entrypoints.length) return;
      if (!resolved.ui?.resourceUri) {
        throw new Error(
          'an OpenAI entrypoint opens an MCP App — link one with ui: {resourceUri}',
        );
      }
      for (const t of types) {
        if (t === 'file') {
          if (!accepts(resolved.input, FILE_SAMPLE)) {
            throw new Error(
              'a file entrypoint is opened with {file: {name, resourceUri}} — ' +
                'the input schema must accept FileEntrypointIn',
            );
          }
        } else if (!accepts(resolved.input, {})) {
          throw new Error(
            `a ${t} entrypoint is opened with {} as its arguments — the ` +
              `input schema must accept an empty object`,
          );
        }
      }
      if (!resolved.icons?.length) {
        warn(
          "@tool('%s'): an OpenAI entrypoint tool should declare icons — " +
            'ChatGPT shows them in navigation',
          resolved.name,
        );
      }
    },
  });
}

/** A sidebar ("global") entrypoint. See {@link openaiUi}. */
export function globalEntrypoint(
  options: {quickAction?: OpenAIQuickAction} = {},
): ToolFragment {
  return openaiUi({entrypoints: [{type: 'global', ...options}]});
}

/** A thread content-tab entrypoint. See {@link openaiUi}. */
export function threadEntrypoint(): ToolFragment {
  return openaiUi({entrypoints: [{type: 'thread'}]});
}

/** A settings-page entrypoint. See {@link openaiUi}. */
export function settingsEntrypoint(
  options: {searchTerms?: string[]} = {},
): ToolFragment {
  return openaiUi({entrypoints: [{type: 'settings', ...options}]});
}

/** A file-extension handler entrypoint (desktop). See {@link openaiUi}. */
export function fileEntrypoint(options: {extensions: string[]}): ToolFragment {
  return openaiUi({entrypoints: [{type: 'file', ...options}]});
}
