// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Installed} from '@agentback/core';

/**
 * The `agentback` stanza a plugin package adds to its `package.json`.
 *
 * @example
 * ```jsonc
 * "agentback": { "plugin": true, "component": "AgentLoopComponent" }
 * ```
 */
export interface PluginPackageMarker {
  plugin: true;
  /** Named export of the package's main module that is a Component. */
  component: string;
  /**
   * DI keys this plugin contributes. Advisory: governs mount ordering and
   * pre-import duplicate detection, never resolution.
   */
  provides?: string[];
  /** DI keys this plugin needs bound before it mounts. Advisory. */
  inject?: string[];
}

/** A discovered (not necessarily mounted) plugin. */
export interface PluginInfo {
  name: string;
  version: string;
  component: string;
  source: 'deps' | 'dir';
  path: string;
  /**
   * What `loadPlugins` passes to `import()`:
   * - `source: 'deps'` -> the bare package specifier (Node resolves `exports`).
   * - `source: 'dir'`  -> a `file://` URL string of the resolved entry module.
   */
  importSpecifier: string;
  /** Normalized from the marker; `[]` when absent or malformed. */
  provides: string[];
  /** Normalized from the marker; `[]` when absent or malformed. */
  inject: string[];
}

export type PluginLoadErrorKind =
  | 'import'
  | 'missing-export'
  | 'not-a-component'
  | 'key-collision'
  | 'unsatisfied-inject'
  | 'dependency-cycle'
  | 'duplicate-provides';

export interface PluginLoadError {
  package: string;
  kind: PluginLoadErrorKind;
  message: string;
  collidingKeys?: string[];
}

/**
 * The record of one `loadPlugins` call — and its inverse. `uninstall()`
 * retracts every plugin that mounted, LIFO, restoring displaced bindings and
 * stopping retracted lifecycle observers. Idempotent.
 *
 * It is attached even when a `strict` load throws mid-way, so the error's
 * report retracts the mounts that DID succeed rather than leaving a
 * half-mounted app with no inverse.
 */
export interface PluginLoadReport extends Installed {
  discovered: PluginInfo[];
  mounted: PluginInfo[];
  skipped: Array<PluginInfo & {reason: 'disabled' | 'not-enabled'}>;
  warnings: string[];
  errors: PluginLoadError[];
}

export interface LoadPluginsOptions {
  config?: unknown;
  cwd?: string;
  strict?: boolean;
}

/**
 * Options for the imperative, single-plugin `loadPlugin`. Unlike the
 * manifest-driven `loadPlugins`, the specifier need not be a declared
 * dependency or carry an `agentback` marker.
 */
export interface LoadPluginOptions {
  /**
   * Named export to mount as the Component. Required when the target has no
   * `agentback` marker; otherwise overrides the marker's `component`.
   */
  component?: string;
  /** DI keys this mount may intentionally re-bind (else a re-bind throws). */
  allowOverride?: string[];
  /** Base directory for resolving relative paths / bare specifiers. */
  cwd?: string;
}
