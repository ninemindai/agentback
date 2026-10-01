// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Icon, ToolAnnotations} from '@modelcontextprotocol/server';
import type {SchemaLike} from '@agentback/openapi';
import type {ToolUiVisibility} from './keys.js';

/**
 * Tool annotations a `@tool` may declare. `title` is omitted on purpose: the
 * tool's top-level `title` is the single source of a tool's display name.
 */
export type ToolAnnotationsInput = Omit<ToolAnnotations, 'title'>;

/** A plain JSON value — what `_meta` may carry. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue};

/** A `_meta` object contributed by a fragment. */
export type MetaObject = Record<string, JsonValue>;

const TOOL_FRAGMENT = Symbol.for('agentback.mcp.toolFragment');
const RESOURCE_FRAGMENT = Symbol.for('agentback.mcp.resourceFragment');

/**
 * The tool options a fragment's `check` sees: the decorator's own options
 * after every fragment has been merged in. `input`/`output` are the real
 * schemas, so a check can validate host rules against them (e.g. "a sidebar
 * entrypoint must accept `{}`").
 */
export interface ResolvedToolOptions {
  name: string;
  input?: SchemaLike;
  output?: SchemaLike;
  ui?: {resourceUri?: string; visibility?: ToolUiVisibility[]};
  annotations?: ToolAnnotationsInput;
  meta?: MetaObject;
  icons?: Icon[];
  confirm?: boolean | {ttlMs?: number};
}

/** The body of a {@link toolFragment}. */
export interface ToolFragmentSpec {
  /** Merged into the tool's `ui:` (visibility is unioned). */
  ui?: {resourceUri?: string; visibility?: ToolUiVisibility[]};
  /** Merged into the tool's annotations; a conflicting value throws. */
  annotations?: ToolAnnotationsInput;
  /** Top-level `_meta` keys; the same key from two sources throws. */
  meta?: MetaObject;
  /**
   * Host rule check, run when `@tool` is applied, against the fully merged
   * options. Throw an `Error` whose message states the rule and the fix; the
   * decorator prefixes it with `@tool('<name>') on <Class>.<method>:`.
   */
  check?: (resolved: ResolvedToolOptions) => void;
}

/**
 * A reusable, self-validating piece of tool metadata, passed to
 * `@tool(..., {extend: [...]})`. Host adapters ship fragments (an OpenAI
 * sidebar entrypoint, a mention-search marker); `toolFragment({meta})` is the
 * escape hatch for emitting a host key by hand.
 */
export interface ToolFragment extends ToolFragmentSpec {
  readonly [TOOL_FRAGMENT]: true;
}

/** Build a {@link ToolFragment}. */
export function toolFragment(spec: ToolFragmentSpec): ToolFragment {
  return {...spec, [TOOL_FRAGMENT]: true};
}

/** The body of a {@link resourceFragment}. */
export interface ResourceFragmentSpec {
  /** `_meta` placed on every content item `resources/read` returns. */
  meta?: MetaObject;
  /** Rule check, run when the resource decorator is applied. */
  check?: (resolved: {
    uri: string;
    mimeType?: string;
    meta?: MetaObject;
  }) => void;
}

/**
 * A reusable piece of resource-content metadata, passed to
 * `@resource(..., {extend: [...]})` / `@appResource(..., {extend: [...]})`.
 */
export interface ResourceFragment extends ResourceFragmentSpec {
  readonly [RESOURCE_FRAGMENT]: true;
}

/** Build a {@link ResourceFragment}. */
export function resourceFragment(spec: ResourceFragmentSpec): ResourceFragment {
  return {...spec, [RESOURCE_FRAGMENT]: true};
}

/** Prefix of `_meta` keys reserved for the MCP spec and SDK. */
const RESERVED_META_PREFIX = 'io.modelcontextprotocol/';

/**
 * Throw unless `value` is plain JSON. Compiled `tools/list` entries are frozen
 * and shared by every caller, so a class instance, function, `undefined` or a
 * non-finite number here would either fail to serialize or leak mutable state.
 */
export function assertJson(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`${path} must be a finite number, got ${value}`);
      }
      return;
    case 'object': {
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertJson(v, `${path}[${i}]`));
        return;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`${path} must be a plain JSON object`);
      }
      for (const [k, v] of Object.entries(value)) assertJson(v, `${path}.${k}`);
      return;
    }
    default:
      throw new Error(`${path} must be JSON, got ${typeof value}`);
  }
}

/** Reject `_meta` keys this framework or the spec owns. */
export function assertMetaKeys(meta: MetaObject, reservedUi: string): void {
  for (const key of Object.keys(meta)) {
    if (key === 'ui') {
      throw new Error(`meta key 'ui' is reserved — ${reservedUi}`);
    }
    if (key.startsWith(RESERVED_META_PREFIX)) {
      throw new Error(
        `meta key '${key}' is reserved for the MCP spec (${RESERVED_META_PREFIX}*)`,
      );
    }
  }
}

function mergeMeta(
  into: MetaObject | undefined,
  add: MetaObject | undefined,
  source: string,
): MetaObject | undefined {
  if (!add) return into;
  const out: MetaObject = {...(into ?? {})};
  for (const [k, v] of Object.entries(add)) {
    if (k in out) {
      throw new Error(`meta key '${k}' is set twice (again by ${source})`);
    }
    out[k] = v;
  }
  return out;
}

/** The merged tool metadata a `@tool` stores. */
export interface MergedToolMeta {
  ui?: {resourceUri?: string; visibility?: ToolUiVisibility[]};
  annotations?: ToolAnnotationsInput;
  meta?: MetaObject;
  icons?: Icon[];
}

/**
 * Merge `@tool` options with its `extend` fragments, apply the derived
 * annotations, and run every fragment's check. Throws an `Error` whose
 * message is the bare rule; the decorator adds the tool/class prefix.
 *
 * Author objects are cloned before they are stored, so freezing the compiled
 * entry never freezes a constant the author shares elsewhere.
 */
export function mergeToolOptions(options: {
  name: string;
  input?: SchemaLike;
  output?: SchemaLike;
  ui?: {resourceUri?: string; visibility?: ToolUiVisibility[]};
  annotations?: ToolAnnotationsInput;
  icons?: Icon[];
  confirm?: boolean | {ttlMs?: number};
  extend?: readonly ToolFragment[];
}): MergedToolMeta {
  let ui = options.ui ? structuredClone(options.ui) : undefined;
  let annotations = options.annotations
    ? {...structuredClone(options.annotations)}
    : undefined;
  let meta: MetaObject | undefined;

  if (annotations && 'title' in annotations) {
    throw new Error(
      `annotations.title is not supported — set the tool's top-level title:`,
    );
  }

  (options.extend ?? []).forEach((fragment, i) => {
    if (!fragment || (fragment as ToolFragment)[TOOL_FRAGMENT] !== true) {
      throw new Error(
        `extend[${i}] is not a tool fragment — build it with toolFragment({...})`,
      );
    }
    const source = `extend[${i}]`;
    if (fragment.ui) {
      const next = structuredClone(fragment.ui);
      if (
        next.resourceUri !== undefined &&
        ui?.resourceUri !== undefined &&
        next.resourceUri !== ui.resourceUri
      ) {
        throw new Error(
          `${source} sets ui.resourceUri '${next.resourceUri}' but the tool already links '${ui.resourceUri}'`,
        );
      }
      const visibility = [
        ...(ui?.visibility ?? []),
        ...(next.visibility ?? []).filter(v => !ui?.visibility?.includes(v)),
      ];
      ui = {
        ...(ui?.resourceUri !== undefined || next.resourceUri !== undefined
          ? {resourceUri: ui?.resourceUri ?? next.resourceUri}
          : {}),
        ...(visibility.length ? {visibility} : {}),
      };
    }
    if (fragment.annotations) {
      if ('title' in fragment.annotations) {
        throw new Error(
          `${source} sets annotations.title — use the tool's top-level title:`,
        );
      }
      for (const [k, v] of Object.entries(fragment.annotations)) {
        const current = (annotations as Record<string, unknown> | undefined)?.[
          k
        ];
        if (current !== undefined && current !== v) {
          throw new Error(
            `${source} sets annotations.${k} to ${JSON.stringify(v)} but it is already ${JSON.stringify(current)}`,
          );
        }
        annotations = {...(annotations ?? {}), [k]: v};
      }
    }
    if (fragment.meta) {
      assertJson(fragment.meta, `${source}.meta`);
      assertMetaKeys(fragment.meta, 'link a widget with the ui: option');
      meta = mergeMeta(meta, structuredClone(fragment.meta), source);
    }
  });

  if (ui && ui.resourceUri === undefined && !ui.visibility?.length) {
    throw new Error(`ui: must set resourceUri, visibility, or both`);
  }

  // `confirm:` marks a tool whose effect warrants a human yes. A read-only
  // tool needs no confirmation, so both at once means one declaration is
  // wrong; otherwise the confirmation implies a destructive effect unless the
  // author said otherwise.
  if (options.confirm) {
    if (annotations?.readOnlyHint === true) {
      throw new Error(
        `confirm: and annotations.readOnlyHint: true contradict each other — a read-only tool needs no confirmation`,
      );
    }
    if (annotations?.destructiveHint === undefined) {
      annotations = {...(annotations ?? {}), destructiveHint: true};
    }
  }

  const icons = options.icons ? structuredClone(options.icons) : undefined;
  const merged: MergedToolMeta = {
    ...(ui ? {ui} : {}),
    ...(annotations ? {annotations} : {}),
    ...(meta ? {meta} : {}),
    ...(icons ? {icons} : {}),
  };

  const resolved: ResolvedToolOptions = {
    name: options.name,
    input: options.input,
    output: options.output,
    confirm: options.confirm,
    ...merged,
  };
  for (const fragment of options.extend ?? []) fragment.check?.(resolved);
  return merged;
}

/**
 * Merge `@resource` fragments into one static content-item `_meta`, running
 * each fragment's check. `base` is metadata the decorator itself builds (the
 * `_meta.ui` of `@appResource`), which fragments may not override.
 */
export function mergeResourceMeta(
  uri: string,
  mimeType: string | undefined,
  base: MetaObject | undefined,
  extend: readonly ResourceFragment[] | undefined,
  reservedUi: string,
): MetaObject | undefined {
  let meta = base ? structuredClone(base) : undefined;
  (extend ?? []).forEach((fragment, i) => {
    if (
      !fragment ||
      (fragment as ResourceFragment)[RESOURCE_FRAGMENT] !== true
    ) {
      throw new Error(
        `extend[${i}] is not a resource fragment — build it with resourceFragment({...})`,
      );
    }
    if (fragment.meta) {
      assertJson(fragment.meta, `extend[${i}].meta`);
      assertMetaKeys(fragment.meta, reservedUi);
      meta = mergeMeta(meta, structuredClone(fragment.meta), `extend[${i}]`);
    }
  });
  for (const fragment of extend ?? []) fragment.check?.({uri, mimeType, meta});
  return meta;
}
