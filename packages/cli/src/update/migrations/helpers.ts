// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import path from 'node:path';
import {SyntaxKind, type CallExpression, type SourceFile} from 'ts-morph';
import type {MigrationContext} from '../migration.js';

/**
 * Every `installMcpHttp(...)` call in the app, with the property names of its
 * options literal.
 *
 * Lives here rather than inside one migration: two advisories need it, and a
 * helper owned by a single migration means deleting that migration breaks its
 * siblings.
 */
export function installMcpHttpCalls(
  ctx: MigrationContext,
): Array<{file: SourceFile; call: CallExpression; options: string[]}> {
  const out: Array<{
    file: SourceFile;
    call: CallExpression;
    options: string[];
  }> = [];
  for (const file of ctx.project().getSourceFiles()) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'installMcpHttp') continue;
      const literal = call
        .getArguments()
        .find(a => a.isKind(SyntaxKind.ObjectLiteralExpression));
      const options = literal
        ? literal
            .asKindOrThrow(SyntaxKind.ObjectLiteralExpression)
            .getProperties()
            .map(
              p => p.getSymbol()?.getName() ?? p.getText().split(':')[0].trim(),
            )
        : [];
      out.push({file, call, options});
    }
  }
  return out;
}

/** App-relative path for a `Finding.file`. */
export function rel(ctx: MigrationContext, file: SourceFile): string {
  return path.relative(ctx.root, file.getFilePath());
}
