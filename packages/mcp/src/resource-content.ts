// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {assertJson, type MetaObject} from './fragments.js';

const RESOURCE_CONTENT = Symbol.for('agentback.mcp.resourceContent');

/** One content item a `@resource` method returns via {@link resourceContent}. */
export interface ResourceContent {
  readonly [RESOURCE_CONTENT]: true;
  readonly text?: string;
  readonly blob?: Uint8Array;
  readonly mimeType?: string;
  readonly meta?: MetaObject;
}

/** One item of a `resources/read` result, as an MCP client receives it. */
export type ResourceContentItem = {
  uri: string;
  mimeType: string;
  _meta?: Record<string, unknown>;
} & (
  | {text: string; blob?: never}
  | {
      /** Base64-encoded binary content. */
      blob: string;
      text?: never;
    }
);

/**
 * A branded `resources/read` content item — the resource counterpart of REST's
 * `fileResponse`. Return one (or an array) from a `@resource` method to serve
 * binary content (`blob`, base64-encoded on the wire) or to attach per-call
 * `_meta`, which is merged over the decorator's static `_meta` (per-call wins;
 * the `ui` object is merged key by key).
 *
 * Unbranded returns keep their existing behaviour (string → text, anything
 * else → JSON text), so this never reinterprets a payload that happens to
 * look like MCP contents.
 */
export function resourceContent(
  body: {text: string} | {blob: Uint8Array},
  options: {mimeType?: string; meta?: MetaObject} = {},
): ResourceContent {
  if (options.meta) {
    assertJson(options.meta, 'resourceContent meta');
    for (const key of Object.keys(options.meta)) {
      if (key.startsWith('io.modelcontextprotocol/')) {
        throw new Error(
          `resourceContent meta key '${key}' is reserved for the MCP spec`,
        );
      }
    }
  }
  if ('blob' in body && !(body.blob instanceof Uint8Array)) {
    throw new Error('resourceContent blob must be a Uint8Array');
  }
  return {
    [RESOURCE_CONTENT]: true,
    ...body,
    ...(options.mimeType !== undefined ? {mimeType: options.mimeType} : {}),
    ...(options.meta ? {meta: structuredClone(options.meta)} : {}),
  };
}

/** True when `value` is a {@link resourceContent} item. */
export function isResourceContent(value: unknown): value is ResourceContent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ResourceContent)[RESOURCE_CONTENT] === true
  );
}

/** Base64 without `Buffer`, so the package stays runtime-neutral. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function mergeItemMeta(
  base: MetaObject | undefined,
  call: MetaObject | undefined,
): Record<string, unknown> | undefined {
  if (!base && !call) return undefined;
  const out: Record<string, unknown> = {...(base ?? {}), ...(call ?? {})};
  const baseUi = base?.ui;
  const callUi = call?.ui;
  if (
    baseUi &&
    callUi &&
    typeof baseUi === 'object' &&
    typeof callUi === 'object' &&
    !Array.isArray(baseUi) &&
    !Array.isArray(callUi)
  ) {
    out.ui = {...baseUi, ...callUi};
  }
  return out;
}

/**
 * Shape a `@resource` method's return value into `resources/read` contents.
 */
export function toResourceContents(
  result: unknown,
  resource: {uri: string; mimeType?: string; meta?: MetaObject},
): ResourceContentItem[] {
  const items = Array.isArray(result) ? result : [result];
  if (items.length > 0 && items.every(isResourceContent)) {
    return items.map((item): ResourceContentItem => {
      const _meta = mergeItemMeta(resource.meta, item.meta);
      return {
        uri: resource.uri,
        mimeType: item.mimeType ?? resource.mimeType ?? 'text/plain',
        ...(item.blob !== undefined
          ? {blob: toBase64(item.blob)}
          : {text: item.text ?? ''}),
        ...(_meta ? {_meta} : {}),
      };
    });
  }
  if (items.some(isResourceContent)) {
    throw new Error(
      `Resource ${resource.uri} returned a mix of resourceContent() items and plain values`,
    );
  }
  const _meta = mergeItemMeta(resource.meta, undefined);
  return [
    {
      uri: resource.uri,
      mimeType: resource.mimeType ?? 'text/plain',
      text: typeof result === 'string' ? result : JSON.stringify(result),
      ...(_meta ? {_meta} : {}),
    },
  ];
}
