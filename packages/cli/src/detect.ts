// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {existsSync} from 'node:fs';
import path from 'node:path';
import {AgentError, ErrorCodes} from '@agentback/openapi';

export function resolveBuilder(opts: {
  entry?: string;
  exportName?: string;
  cwd: string;
}): {entry: string; exportName: string} {
  if (opts.entry) {
    return {entry: opts.entry, exportName: opts.exportName ?? 'buildApp'};
  }
  const probes: Array<{file: string; entry: string; exportName: string}> = [
    {
      file: 'dist/console.js',
      entry: './dist/console.js',
      exportName: 'buildConsoleApp',
    },
    {file: 'dist/main.js', entry: './dist/main.js', exportName: 'buildApp'},
  ];
  for (const probe of probes) {
    if (existsSync(path.join(opts.cwd, probe.file))) {
      return {
        entry: probe.entry,
        exportName: opts.exportName ?? probe.exportName,
      };
    }
  }
  throw new AgentError(
    'Could not find a built app builder. Build your app, then pass ' +
      '--entry <built-module> --export <builderFn> (e.g. ' +
      '--entry ./dist/main.js --export buildApp).',
    {code: ErrorCodes.INVALID_INPUT},
  );
}

export function enforceConsoleGate(a: {
  console: boolean;
  unsafePublicConsole: boolean;
}): void {
  if (a.console && !a.unsafePublicConsole) {
    throw new AgentError(
      'Deploying the dev console publishes your DI container, schemas, and ' +
        'MCP inspector. Configure auth, or pass --unsafe-public-console to ' +
        'acknowledge a public, unauthenticated console.',
      {code: ErrorCodes.INVALID_INPUT},
    );
  }
}
