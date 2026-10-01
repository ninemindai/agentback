// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Icon} from '@modelcontextprotocol/server';
import {MethodDecoratorFactory} from '@agentback/metadata';
import {
  assertIcons,
  mergeResourceMeta,
  type JsonValue,
  type MetaObject,
  type ResourceFragment,
} from '../fragments.js';
import {
  MCP_APP_MIME_TYPE,
  MCPKeys,
  type AppDomainResolver,
  type ResourceMetadata,
} from '../keys.js';

export interface ResourceOptions {
  description?: string;
  mimeType?: string;
  /** Display title on the `resources/list` entry. */
  title?: string;
  /** Icons on the `resources/list` entry. */
  icons?: Icon[];
  /**
   * Fragments whose `meta` is placed on every content item `resources/read`
   * returns. `_meta.ui` is reserved: declare an MCP Apps widget with
   * `@appResource`.
   */
  extend?: readonly ResourceFragment[];
}

function decorate(
  decoratorName: string,
  uri: string,
  options: ResourceOptions & {name?: string},
  baseMeta: MetaObject | undefined,
  reservedUi: string,
  uiDomain?: AppDomainResolver,
): MethodDecorator {
  return function resourceDecorator(
    target: Object,
    methodName: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    let meta: MetaObject | undefined;
    try {
      if (options.icons) assertIcons(options.icons, 'icons');
      meta = mergeResourceMeta(
        uri,
        options.mimeType,
        baseMeta,
        options.extend,
        reservedUi,
      );
    } catch (err) {
      const className =
        (target as {constructor?: {name: string}}).constructor?.name ??
        'anonymous';
      throw new Error(
        `${decoratorName}('${uri}') on ${className}.${String(methodName)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        {cause: err},
      );
    }
    const resourceMeta: ResourceMetadata = {
      name: options.name ?? String(methodName),
      uri,
      description: options.description,
      mimeType: options.mimeType,
      ...(options.title !== undefined ? {title: options.title} : {}),
      ...(options.icons ? {icons: structuredClone(options.icons)} : {}),
      ...(meta ? {meta} : {}),
      ...(uiDomain ? {uiDomain} : {}),
      methodName,
    };
    MethodDecoratorFactory.createDecorator<ResourceMetadata>(
      MCPKeys.RESOURCE,
      resourceMeta,
      {decoratorName},
    )(target, methodName, descriptor);
  };
}

/**
 * Declare a method as an MCP resource served at an exact `uri`.
 *
 * The method may return a string (served as text), any other value (served as
 * JSON text), or {@link resourceContent} items for binary content or per-call
 * `_meta`.
 */
export function resource(
  uri: string,
  options: ResourceOptions & {name?: string} = {},
): MethodDecorator {
  return decorate(
    '@resource',
    uri,
    options,
    undefined,
    'declare an MCP Apps widget with @appResource',
  );
}

/**
 * Content Security Policy for an MCP Apps widget (SEP-1865 `_meta.ui.csp`).
 * When omitted, conformant hosts apply a restrictive default: no network, no
 * external resources.
 */
export interface AppCsp {
  /** Origins for fetch/XHR/WebSocket. */
  connectDomains?: string[];
  /** Origins for scripts, images, styles and fonts. */
  resourceDomains?: string[];
  /** Origins for nested iframes. */
  frameDomains?: string[];
  /** Allowed `<base>` URIs. */
  baseUriDomains?: string[];
}

/** Browser permissions an MCP Apps widget requests (`_meta.ui.permissions`). */
export interface AppPermissions {
  camera?: Record<string, never>;
  microphone?: Record<string, never>;
  geolocation?: Record<string, never>;
  clipboardWrite?: Record<string, never>;
}

export interface AppResourceOptions {
  name?: string;
  description?: string;
  title?: string;
  icons?: Icon[];
  /** Widget CSP; omitted → the host's restrictive default. */
  csp?: AppCsp;
  /** Browser permissions the widget requests. */
  permissions?: AppPermissions;
  /**
   * Dedicated sandbox origin. Its format is **host-specific** — see each
   * host's documentation (e.g. Claude derives it from your server URL).
   *
   * A string is sent to every host. A function is resolved on every
   * `resources/read`, after `@authorize`, with the request's client, mount
   * and context — return `undefined` to let that host use its default. A
   * per-call `resourceContent({meta: {ui: {domain}}})` still wins.
   */
  domain?: string | AppDomainResolver;
  /** Ask the host for (or against) a visible border and background. */
  prefersBorder?: boolean;
  /** Extra content-item `_meta` (e.g. host display-mode fragments). */
  extend?: readonly ResourceFragment[];
}

const CSP_KEYS = new Set([
  'connectDomains',
  'resourceDomains',
  'frameDomains',
  'baseUriDomains',
]);
const PERMISSION_KEYS = new Set([
  'camera',
  'microphone',
  'geolocation',
  'clipboardWrite',
]);

function buildUiMeta(uri: string, options: AppResourceOptions): MetaObject {
  if (!uri.startsWith('ui://')) {
    throw new Error(
      `@appResource('${uri}'): MCP Apps widget URIs must start with ui://`,
    );
  }
  const ui: Record<string, JsonValue> = {};
  if (options.csp) {
    for (const [k, v] of Object.entries(options.csp)) {
      if (!CSP_KEYS.has(k)) {
        throw new Error(`@appResource('${uri}'): unknown csp key '${k}'`);
      }
      if (!Array.isArray(v) || v.some(d => typeof d !== 'string')) {
        throw new Error(`@appResource('${uri}'): csp.${k} must be a string[]`);
      }
    }
    ui.csp = structuredClone(options.csp) as JsonValue;
  }
  if (options.permissions) {
    for (const k of Object.keys(options.permissions)) {
      if (!PERMISSION_KEYS.has(k)) {
        throw new Error(`@appResource('${uri}'): unknown permission '${k}'`);
      }
    }
    ui.permissions = structuredClone(options.permissions) as JsonValue;
  }
  if (typeof options.domain === 'string') ui.domain = options.domain;
  else if (
    options.domain !== undefined &&
    typeof options.domain !== 'function'
  ) {
    throw new Error(
      `@appResource('${uri}'): domain must be a string or a function`,
    );
  }
  if (options.prefersBorder !== undefined) {
    ui.prefersBorder = options.prefersBorder;
  }
  return Object.keys(ui).length ? {ui} : {};
}

/**
 * Declare an MCP Apps (SEP-1865) widget resource. Fixes the MIME type to
 * {@link MCP_APP_MIME_TYPE}, requires a `ui://` URI, and emits the typed
 * `_meta.ui` (csp, permissions, domain, prefersBorder) on the content item
 * `resources/read` returns — where the spec places it.
 *
 * @example
 *   @appResource('ui://weather/forecast', {
 *     csp: {connectDomains: ['https://api.example.com']},
 *     prefersBorder: true,
 *   })
 *   forecastWidget() { return WIDGET_HTML; }
 *
 * @experimental Host extensions are still settling (phase 1a of
 * docs/proposals/host-extensions.md); the shape may change in a minor release.
 */
export function appResource(
  uri: string,
  options: AppResourceOptions = {},
): MethodDecorator {
  const base = buildUiMeta(uri, options);
  return decorate(
    '@appResource',
    uri,
    {
      name: options.name,
      description: options.description,
      title: options.title,
      icons: options.icons,
      extend: options.extend,
      mimeType: MCP_APP_MIME_TYPE,
    },
    Object.keys(base).length ? base : undefined,
    'set it through the @appResource options',
    typeof options.domain === 'function' ? options.domain : undefined,
  );
}
