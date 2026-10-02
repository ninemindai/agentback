// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Icon} from '@modelcontextprotocol/server';
import type {JsonValue} from '@agentback/mcp';
import {assertImageIcon, nonBlank} from './shared.js';

// OpenAI form elicitation (spec "OpenAI Form Elicitation"): the JSON Schema
// a 2026-era client declaring `openai/elicitation` renders with richer
// controls. These builders produce the `extended` half of `elicit.ask` —
// `standard` stays the Zod form every other client gets, and the answer is
// validated against `standard` either way, so make it accept what the
// extended form submits (e.g. a URI string for a resource field).

const FIELD = Symbol.for('agentback.mcpOpenai.formField');

/** One field of an OpenAI form; build it with the helpers below. */
export interface OpenAIFormField {
  readonly [FIELD]: true;
  readonly schema: Record<string, JsonValue>;
}

function field(schema: Record<string, JsonValue>): OpenAIFormField {
  return {[FIELD]: true, schema};
}

/** A titled choice: an option, a suggestion, with optional thumbnail. */
export interface OpenAIOption {
  const: string;
  title: string;
  description?: string;
  /** Rendered instead of plain text; https URL or data:image/ URI. */
  thumbnail?: Icon;
}

function optionJson(o: OpenAIOption, at: string): JsonValue {
  nonBlank(o.const, `${at}.const`);
  nonBlank(o.title, `${at}.title`);
  assertImageIcon(o.thumbnail, `${at}.thumbnail`);
  return {
    const: o.const,
    title: o.title,
    ...(o.description !== undefined ? {description: o.description} : {}),
    ...(o.thumbnail
      ? {'x-openai-thumbnail': structuredClone(o.thumbnail) as JsonValue}
      : {}),
  };
}

interface Labels {
  title?: string;
  description?: string;
}

function labels(l: Labels): Record<string, JsonValue> {
  return {
    ...(l.title !== undefined ? {title: l.title} : {}),
    ...(l.description !== undefined ? {description: l.description} : {}),
  };
}

/**
 * A free-text field, optionally constrained by `pattern` and offering
 * `suggestions` the user may pick or ignore.
 */
export function textField(
  options: Labels & {
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    suggestions?: OpenAIOption[];
    default?: string;
  } = {},
): OpenAIFormField {
  if (options.pattern !== undefined) new RegExp(options.pattern, 'u');
  return field({
    type: 'string',
    ...labels(options),
    ...(options.pattern !== undefined ? {pattern: options.pattern} : {}),
    ...(options.minLength !== undefined ? {minLength: options.minLength} : {}),
    ...(options.maxLength !== undefined ? {maxLength: options.maxLength} : {}),
    ...(options.suggestions
      ? {
          'x-openai-suggestions': options.suggestions.map((o, i) =>
            optionJson(o, `suggestions[${i}]`),
          ),
        }
      : {}),
    ...(options.default !== undefined ? {default: options.default} : {}),
  });
}

/**
 * A choice among titled options (with descriptions and thumbnails). If any
 * option has a thumbnail, ChatGPT renders every option as an image — give all
 * of them one.
 */
export function choiceField(
  options: Labels & {
    options: OpenAIOption[];
    multiple?: boolean;
    default?: string | string[];
  },
): OpenAIFormField {
  if (!options.options?.length) {
    throw new Error('choiceField: options needs at least one option');
  }
  const opts = options.options.map((o, i) => optionJson(o, `options[${i}]`));
  const consts = options.options.map(o => o.const);
  const defaults =
    options.default === undefined ? [] : [options.default].flat();
  for (const d of defaults) {
    if (!consts.includes(d)) {
      throw new Error(`choiceField: default '${d}' is not one of the options`);
    }
  }
  if (!options.multiple && Array.isArray(options.default)) {
    throw new Error('choiceField: a single choice takes one default');
  }
  return field(
    options.multiple
      ? {
          type: 'array',
          ...labels(options),
          items: {anyOf: opts},
          ...(options.default !== undefined ? {default: defaults} : {}),
        }
      : {
          type: 'string',
          ...labels(options),
          oneOf: opts,
          ...(options.default !== undefined
            ? {default: options.default as string}
            : {}),
        },
  );
}

/** A resource the server offers in a {@link resourceField}. */
export interface OpenAIResourceOption {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** Extra resource `_meta` — e.g. `openai/thumbnail`, `openai/preview`. */
  _meta?: Record<string, JsonValue>;
}

/**
 * A resource picker (`x-openai-input`): the user selects among `options`,
 * and/or adds files or directories when `userOptions` is set. Single-select
 * submits a URI string; `multiple` submits an array of URI strings.
 *
 * The spec's rules are checked here: `selection` only on a multi-select;
 * defaults must name supplied options; no default with `implicit` selection.
 */
export function resourceField(
  options: Labels & {
    options: OpenAIResourceOption[];
    userOptions?: {kind?: 'file' | 'directory'; accept?: string[]};
    multiple?: boolean;
    /** Multi-select only: pick by toggling (`explicit`) or by keeping (`implicit`). */
    selection?: 'explicit' | 'implicit';
    default?: string | string[];
  },
): OpenAIFormField {
  if (!Array.isArray(options.options)) {
    throw new Error('resourceField: options must be an array (may be empty)');
  }
  options.options.forEach((r, i) => {
    nonBlank(r.uri, `options[${i}].uri`);
    nonBlank(r.name, `options[${i}].name`);
  });
  if (options.selection && !options.multiple) {
    throw new Error('resourceField: selection applies only to multiple');
  }
  if (options.default !== undefined) {
    if (options.selection === 'implicit') {
      throw new Error('resourceField: implicit selection cannot set a default');
    }
    if (!options.multiple && Array.isArray(options.default)) {
      throw new Error('resourceField: a single select takes one default');
    }
    const uris = options.options.map(r => r.uri);
    for (const d of [options.default].flat()) {
      if (!uris.includes(d)) {
        throw new Error(
          `resourceField: default '${d}' must name one of the supplied options`,
        );
      }
    }
  }
  const input: Record<string, JsonValue> = {
    type: 'resource',
    options: structuredClone(options.options) as unknown as JsonValue,
    ...(options.userOptions
      ? {userOptions: structuredClone(options.userOptions) as JsonValue}
      : {}),
    ...(options.selection ? {selection: options.selection} : {}),
  };
  const uri = {type: 'string', format: 'uri'} as const;
  return field(
    options.multiple
      ? {
          type: 'array',
          ...labels(options),
          items: uri,
          'x-openai-input': input,
          ...(options.default !== undefined
            ? {default: [options.default].flat()}
            : {}),
        }
      : {
          ...uri,
          ...labels(options),
          'x-openai-input': input,
          ...(options.default !== undefined
            ? {default: options.default as string}
            : {}),
        },
  );
}

/**
 * Assemble an OpenAI form — the `extended` of `elicit.ask`. Plain JSON
 * Schema fields are accepted too, for anything the helpers don't cover.
 *
 * @example
 *   await elicit.ask('part', {
 *     message: 'Which part?',
 *     standard: z.object({part: z.string()}),
 *     extended: openaiForm({part: resourceField({options: parts})}, {required: ['part']}),
 *   });
 *
 * @experimental Tracks OpenAI's MCP extensions spec (0.1.x).
 */
export function openaiForm(
  properties: Record<string, OpenAIFormField | Record<string, JsonValue>>,
  options: {required?: string[]} = {},
): Record<string, unknown> {
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(properties)) {
    out[k] =
      (v as OpenAIFormField)[FIELD] === true
        ? (v as OpenAIFormField).schema
        : (structuredClone(v) as JsonValue);
  }
  for (const r of options.required ?? []) {
    if (!Object.hasOwn(out, r))
      throw new Error(`openaiForm: required '${r}' is not a field`);
  }
  return {
    type: 'object',
    properties: out,
    ...(options.required?.length ? {required: [...options.required]} : {}),
  };
}
