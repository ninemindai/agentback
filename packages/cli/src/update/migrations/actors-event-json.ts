// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {SyntaxKind} from 'ts-morph';
import type {Finding, Migration} from '../migration.js';
import {rel} from './helpers.js';

/**
 * 0.10.0 validates each event in `turn.events` at commit, on every runtime,
 * and rejects non-JSON values (`Date`, `undefined`, `NaN`/`Infinity`,
 * `BigInt`). Previously Redis silently coerced what the in-memory runtimes
 * preserved, so an app tested in-memory could commit events that differ from
 * the ones its turns emitted. A bare `new Date()` inside an `events` payload
 * is the common case, and it is a runtime rejection the compiler cannot see.
 */
export const actorsEventJson: Migration = {
  id: 'actors-event-json',
  version: '0.10.0',
  title: "A turn's events must be plain, finite JSON",
  detect(ctx) {
    const findings: Finding[] = [];
    const files = ctx.project().getSourceFiles();

    // Guard: `events:` properties exist far outside the actor runtime; only
    // an app that defines actors can hit the commit-time validator.
    const usesActors = files.some(f =>
      /@actor\(|defineActor\(/.test(f.getFullText()),
    );
    for (const file of usesActors ? files : []) {
      for (const prop of file.getDescendantsOfKind(
        SyntaxKind.PropertyAssignment,
      )) {
        if (prop.getName() !== 'events') continue;
        for (const nw of prop.getDescendantsOfKind(SyntaxKind.NewExpression)) {
          if (nw.getExpression().getText() !== 'Date') continue;
          // `new Date().toISOString()` / `.getTime()` are the fixes — a Date
          // that is immediately projected to a JSON value is fine.
          if (nw.getParentIfKind(SyntaxKind.PropertyAccessExpression)) {
            continue;
          }
          findings.push({
            file: rel(ctx, file),
            line: nw.getStartLineNumber(),
            message: "A bare `new Date()` inside a turn's `events` payload.",
            action:
              'Every runtime now validates events at commit and rejects ' +
              'non-JSON values (Date, undefined, NaN/Infinity, BigInt) with ' +
              'the offending path, before anything is written. Serialize ' +
              'when emitting: `at: new Date().toISOString()`. `state` and ' +
              '`result` are unaffected.',
          });
        }
      }
    }
    return findings;
  },
};
