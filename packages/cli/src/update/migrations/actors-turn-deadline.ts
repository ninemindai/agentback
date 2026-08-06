// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {SyntaxKind} from 'ts-morph';
import type {Finding, Migration} from '../migration.js';
import {rel} from './helpers.js';

const DEADLINE_OPTIONS = ['seatClass', 'deadlineMs'];

/**
 * 0.10.0 made every actor turn run under a per-seat-class deadline, and a
 * definition that declares nothing gets the 30s `'capability'` default. An
 * existing actor whose turns legitimately run longer starts throwing
 * `TurnTimeoutError` on upgrade — behavior-shaped, invisible to the compiler,
 * so it is an advisory: the CLI cannot know which actors legitimately run
 * long.
 */
export const actorsTurnDeadline: Migration = {
  id: 'actors-turn-deadline',
  version: '0.10.0',
  title: 'Every actor turn now runs under a deadline (30s default)',
  detect(ctx) {
    const findings: Finding[] = [];
    for (const file of ctx.project().getSourceFiles()) {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const name = call.getExpression().getText();
        const isActorDecorator =
          name === 'actor' &&
          call.getParentIfKind(SyntaxKind.Decorator) !== undefined;
        if (!isActorDecorator && name !== 'defineActor') continue;

        // Options we cannot see through (an identifier, a spread) are skipped
        // rather than flagged — an advisory that cries wolf gets ignored.
        const options = call.getArguments()[1];
        if (options && !options.isKind(SyntaxKind.ObjectLiteralExpression)) {
          continue;
        }
        const props = options
          ? options
              .asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
              .getProperties()
              .map(
                p =>
                  p.getSymbol()?.getName() ?? p.getText().split(':')[0].trim(),
              )
          : [];
        if (props.some(p => DEADLINE_OPTIONS.includes(p))) continue;

        const subject = call.getArguments()[0]?.getText() ?? '(unnamed)';
        findings.push({
          file: rel(ctx, file),
          line: call.getStartLineNumber(),
          message: `${
            isActorDecorator ? '@actor' : 'defineActor'
          }(${subject}) declares neither seatClass nor deadlineMs.`,
          action:
            'Turns previously ran unbounded; every turn is now deadlined at ' +
            "30s (the 'capability' default). A turn that legitimately runs " +
            'longer starts throwing TurnTimeoutError — nothing commits, the ' +
            'seat is freed, and the requestId stays retryable. If this ' +
            "actor's turns can exceed 30s, declare seatClass: 'worker' " +
            '(10 min) or an explicit deadlineMs on the definition.',
        });
      }
    }
    return findings;
  },
};
