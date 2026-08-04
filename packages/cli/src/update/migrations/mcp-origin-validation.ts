// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Finding, Migration} from '../migration.js';
import {installMcpHttpCalls, rel} from './helpers.js';

export const mcpOriginValidation: Migration = {
  id: 'mcp-origin-validation',
  version: '0.9.0',
  title: 'Origin is validated by default on the stateless mount',
  detect(ctx) {
    const findings: Finding[] = [];
    const wildcardCors = ctx
      .project()
      .getSourceFiles()
      .some(f => /cors\s*:\s*(true|\([^)]*\)\s*=>)/.test(f.getFullText()));
    if (!wildcardCors) return findings;

    for (const {file, call, options} of installMcpHttpCalls(ctx)) {
      if (options.includes('allowedOrigins')) continue;
      findings.push({
        file: rel(ctx, file),
        line: call.getStartLineNumber(),
        message:
          'installMcpHttp has no `allowedOrigins`, and `rest.cors` enumerates ' +
          'nothing (wildcard or callback).',
        action:
          'When allowedOrigins is unset the policy is derived from rest.cors. ' +
          'A callback or true wildcard enumerates nothing, so validation warns ' +
          'and stays OFF. Set allowedOrigins explicitly to get protection.',
      });
    }
    return findings;
  },
};
