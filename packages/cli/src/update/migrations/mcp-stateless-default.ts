// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {Finding, Migration} from '../migration.js';
import {installMcpHttpCalls, rel} from './helpers.js';

export const mcpStatelessDefault: Migration = {
  id: 'mcp-stateless-default',
  version: '0.9.0',
  title: "MCP over HTTP defaults to protocol: 'both' (stateless)",
  detect(ctx) {
    const findings: Finding[] = [];

    for (const {file, call, options} of installMcpHttpCalls(ctx)) {
      if (options.includes('eventStore') && !options.includes('protocol')) {
        findings.push({
          file: rel(ctx, file),
          line: call.getStartLineNumber(),
          message:
            'installMcpHttp sets `eventStore` (resumable SSE, a session ' +
            'feature) without naming a `protocol`.',
          action:
            "0.9.0 keeps this mount on 'legacy' so the capability is not " +
            "silently dropped. Name protocol: 'legacy' explicitly to make " +
            'that intent visible, or migrate off eventStore to adopt the ' +
            'stateless default.',
        });
      }
    }

    for (const file of ctx.project().getSourceFiles()) {
      const text = file.getFullText();
      const idx = text.search(/mcp-session-id/i);
      if (idx === -1) continue;
      findings.push({
        file: rel(ctx, file),
        line: file.getLineAndColumnAtPos(idx).line,
        message: 'Code reads or sets the `Mcp-Session-Id` header.',
        action:
          "Sessions do not exist under the 0.9.0 default (protocol: 'both'). " +
          "Either remove the session dependency or pin protocol: 'legacy'.",
      });
    }

    return findings;
  },
};
