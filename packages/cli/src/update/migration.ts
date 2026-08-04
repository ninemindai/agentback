// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Project} from 'ts-morph';
import {compareVersions, type PackageJson} from './versions.js';

export interface Finding {
  /** App-relative path, when the finding points at a file. */
  file?: string;
  line?: number;
  /** What was found. */
  message: string;
  /** What the user should do — the migration note, when `apply` cannot. */
  action: string;
}

export interface MigrationContext {
  /** App root. Every `Finding.file` is relative to it. */
  root: string;
  /** Parsed package.json, PRE-bump — migrations run before the bump lands. */
  pkg: PackageJson;
  /**
   * ts-morph project over the app's sources. Lazy: an advisory that only reads
   * package.json or a config file never pays to parse the source tree.
   */
  project(): Project;
  from: string;
  to: string;
}

export interface Migration {
  /** Stable slug, e.g. 'mcp-stateless-default'. */
  id: string;
  /** The released version that introduced the break. */
  version: string;
  title: string;
  /** Static analysis only — never boots the app. */
  detect(ctx: MigrationContext): Finding[];
  /**
   * Present ⇒ codemod. Absent ⇒ advisory.
   *
   * WHEN YOU WRITE THE FIRST REAL ONE: rewriting declarations is not the whole
   * job. This repo's MCP v1→v2 codemod rewrote imports and class names but not
   * PROPERTY READS — `OAuthError.errorCode` → `.code` was missed, so the
   * result compiled cleanly and served `error="undefined"` at runtime. A
   * codemod that type-checks is not a codemod that is correct. Enumerate the
   * property reads, and pair every transform with a test asserting
   * post-conditions on behaviour, not just on shape.
   */
  apply?(ctx: MigrationContext): void;
}

/**
 * Migrations that apply when moving `from` → `to`, as the half-open window
 * `(from, to]`: the version you are already on introduced nothing new for you,
 * the version you are moving to did.
 */
export function selectMigrations(
  all: readonly Migration[],
  from: string,
  to: string,
): Migration[] {
  return all
    .filter(
      x =>
        compareVersions(x.version, from) > 0 &&
        compareVersions(x.version, to) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
}
