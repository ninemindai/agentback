#!/usr/bin/env node
// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

export const USAGE = `agentback — deploy an AgentBack app

Usage:
  agentback deploy vercel [options]

Run \`agentback deploy vercel --help\` for options.
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, target] = argv;
  if (cmd === 'deploy' && target === 'vercel') {
    // wired up in Task 8
    console.error('not yet implemented');
    return 1;
  }
  console.log(USAGE);
  return cmd ? 1 : 0;
}

// Bin entry: run main when invoked directly.
const invokedDirectly = process.argv[1]?.endsWith('cli.js');
if (invokedDirectly) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
