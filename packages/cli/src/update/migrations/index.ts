// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Migration} from '../migration.js';
import {mcpOriginValidation} from './mcp-origin-validation.js';
import {mcpStatelessDefault} from './mcp-stateless-default.js';
import {mcpStatelessScopeHoles} from './mcp-stateless-scope-holes.js';

/**
 * Every migration, ordered by version. v1 ships advisories only — no released
 * version ever shipped a source-mechanical breaking change, so there is
 * nothing to codemod. See docs/proposals/cli-lifecycle.md.
 */
export const MIGRATIONS: readonly Migration[] = [
  mcpStatelessDefault,
  mcpStatelessScopeHoles,
  mcpOriginValidation,
];
