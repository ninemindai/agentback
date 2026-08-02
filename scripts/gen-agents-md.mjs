#!/usr/bin/env node
// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

// Generate AGENTS.md from CLAUDE.md.
//
// AGENTS.md is what non-Claude harnesses (Codex, Cursor) read. It is
// deliberately gitignored (see .gitignore and commit e373b60) — it is a local
// workflow file, not a repo doc surface. Hand-maintaining a second copy of a
// 250-line architecture description does not work: by 2026-07 it had drifted
// ~71 lines behind, was missing the `agents` and `command` packages entirely,
// and described `mcp-http` three releases out of date.
//
// WHY THIS SCRIPT IS SO CONSERVATIVE. The drifted copy had been produced by a
// blanket s/claude/Codex/, which also rewrote:
//
//   `claude-agent-acp`  ->  `Codex-agent-acp`     (a real binary; now fictional)
//   "Claude Desktop"    ->  "Codex Desktop"       (a real MCP host; now fictional)
//
// A harness reading that would go looking for software that does not exist.
// The lesson is that most "Claude" mentions in CLAUDE.md are FACTS ABOUT THE
// WORLD — product names, binary names, package names — and only the file's own
// framing line is addressed to a particular harness. So this rewrites exactly
// that line and the title, and copies everything else byte-for-byte.
//
// Run: `pnpm agents-md` (or `node scripts/gen-agents-md.mjs --check`).

import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const root = join(import.meta.dirname, '..');
const SRC = join(root, 'CLAUDE.md');
const OUT = join(root, 'AGENTS.md');

/**
 * The only harness-specific content in the file. Each entry must match exactly
 * once — a silent no-op here is how the copy drifts, so a miss is an error.
 */
const REWRITES = [
  {
    from: '# CLAUDE.md\n',
    to: '# AGENTS.md\n',
  },
  {
    from:
      'This file provides guidance to Claude Code (claude.ai/code) when ' +
      'working with code in this repository.',
    to:
      'This file provides guidance to coding agents (Codex, Cursor, and other ' +
      'harnesses that read AGENTS.md) when working with code in this ' +
      'repository.\n\n' +
      '> **Generated file — do not edit.** Produced from `CLAUDE.md` by\n' +
      '> `scripts/gen-agents-md.mjs`. Edit `CLAUDE.md` and run `pnpm agents-md`.\n' +
      '> Everything below is copied verbatim, including product and binary\n' +
      '> names that contain "Claude" (`claude-agent-acp`, Claude Desktop) —\n' +
      '> those are real names, not branding to substitute.',
  },
];

const source = readFileSync(SRC, 'utf8');
let out = source;
for (const {from, to} of REWRITES) {
  const count = out.split(from).length - 1;
  if (count !== 1) {
    console.error(
      `gen-agents-md: expected exactly 1 occurrence of ${JSON.stringify(
        from.slice(0, 60),
      )}, found ${count}. CLAUDE.md's header changed — update REWRITES.`,
    );
    process.exit(1);
  }
  out = out.replace(from, to);
}

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {
    console.error('gen-agents-md: AGENTS.md is missing. Run `pnpm agents-md`.');
    process.exit(1);
  }
  if (current !== out) {
    console.error(
      'gen-agents-md: AGENTS.md is stale. Run `pnpm agents-md` to regenerate.',
    );
    process.exit(1);
  }
  console.log('AGENTS.md is in sync with CLAUDE.md.');
} else {
  writeFileSync(OUT, out);
  console.log(
    `Wrote AGENTS.md (${out.split('\n').length} lines) from CLAUDE.md.`,
  );
}
