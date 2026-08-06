// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Migration} from '../migration.js';
import {actorsEventJson} from './actors-event-json.js';
import {actorsRedisDedupTtl} from './actors-redis-dedup-ttl.js';
import {actorsTurnDeadline} from './actors-turn-deadline.js';
import {mcpOriginValidation} from './mcp-origin-validation.js';
import {mcpStatelessDefault} from './mcp-stateless-default.js';
import {mcpStatelessScopeHoles} from './mcp-stateless-scope-holes.js';

/**
 * Every migration, ordered by version. Advisories only so far — no released
 * version has shipped a source-mechanical breaking change, so there is
 * nothing to codemod. See docs/proposals/cli-lifecycle.md.
 *
 * The 0.10.0 seat-layer wave also changed two compile-visible signatures
 * (`ActorEventStore.subscribe` handler widening; required `seatClass` +
 * `deadlineMs` on hand-built `ActorDefinition` literals). Those carry no
 * advisory on purpose: the compiler reports them with an obvious fix, and
 * advisories exist for what compiles-or-runs silently. See
 * docs/releases/v0.10.0.md.
 */
export const MIGRATIONS: readonly Migration[] = [
  mcpStatelessDefault,
  mcpStatelessScopeHoles,
  mcpOriginValidation,
  actorsTurnDeadline,
  actorsEventJson,
  actorsRedisDedupTtl,
];
