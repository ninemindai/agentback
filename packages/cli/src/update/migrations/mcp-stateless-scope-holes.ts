// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Finding, Migration} from '../migration.js';
import {rel} from './helpers.js';

export const mcpStatelessScopeHoles: Migration = {
  id: 'mcp-stateless-scope-holes',
  version: '0.9.0',
  title: 'Stateless scope filtering and confirmation-store lifetime',
  detect(ctx) {
    const findings: Finding[] = [];
    const files = ctx.project().getSourceFiles();
    const all = files.map(f => f.getFullText()).join('\n');

    // Guard before the loop: `optionalAuth` is computed across all files and
    // cannot change inside it.
    const optionalAuth = /required\s*:\s*false/.test(all);
    for (const file of optionalAuth ? files : []) {
      if (!/@tool\([^)]*scope\s*:/s.test(file.getFullText())) continue;
      findings.push({
        file: rel(ctx, file),
        message:
          'Scoped @tool declarations combined with `required: false` auth.',
        action:
          'Under the stateless default an anonymous caller must be filtered ' +
          'with an empty scope list, not an absent one. Verify scoped tools ' +
          'are invisible to anonymous callers after upgrading — @tool({scope}) ' +
          'is a visibility gate and nothing downstream re-checks it.',
      });
    }

    const usesConfirm = /@tool\(\s*['"`]confirm:/.test(all);
    const bindsStore = /CONFIRMATION_STORE/.test(all);
    if (usesConfirm && !bindsStore) {
      findings.push({
        message:
          'App declares `confirm:` tools but binds no confirmation store.',
        action:
          'A confirm: round trip spans two requests. Bind ' +
          'MCPBindings.CONFIRMATION_STORE explicitly (Redis for ' +
          'multi-instance) so tokens survive between them.',
      });
    }

    return findings;
  },
};
