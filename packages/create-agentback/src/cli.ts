#!/usr/bin/env node
// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  detectPackageManager,
  scaffold,
  TEMPLATES,
  type TemplateName,
} from './scaffold.js';

const USAGE = `create-agentback — scaffold an AgentBack app

Usage:
  npm create agentback <name> [-- --template ${TEMPLATES.join('|')}]

Options:
  -t, --template <name>   Template: ${TEMPLATES.join(', ')} (default: hybrid)
  -h, --help              Show this help
`;

function fail(msg: string): never {
  console.error(`error: ${msg}\n`);
  console.error(USAGE);
  process.exit(1);
}

const args = process.argv.slice(2);
let name: string | undefined;
let template: TemplateName | undefined;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    console.log(USAGE);
    process.exit(0);
  } else if (a === '-t' || a === '--template') {
    template = args[++i] as TemplateName;
  } else if (a.startsWith('--template=')) {
    template = a.slice('--template='.length) as TemplateName;
  } else if (a.startsWith('-')) {
    fail(`unknown option '${a}'`);
  } else if (!name) {
    name = a;
  } else {
    fail(`unexpected argument '${a}'`);
  }
}

if (!name) fail('missing app name');

try {
  const result = scaffold({name, template});
  const pm = detectPackageManager();
  const run = pm === 'npm' ? 'npm run' : pm;
  console.log(
    `\nScaffolded '${name}' (${result.template} template) in ${result.dir}\n`,
  );
  console.log(`Next steps:`);
  console.log(`  cd ${name.includes('/') ? name.split('/')[1] : name}`);
  console.log(`  ${pm} install`);
  console.log(
    `  ${run} build && ${pm === 'npm' ? 'npm start' : `${pm} start`}`,
  );
  console.log(`  ${pm} test\n`);
} catch (err) {
  fail((err as Error).message);
}
