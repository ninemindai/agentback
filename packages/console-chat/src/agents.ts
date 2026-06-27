// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

/**
 * Agent catalog, discovery, and doctor for the console-chat ACP dock.
 *
 * `discoverAgents` and `doctor` accept an injected `runProbe` function
 * (default = a real `execFile`-based PATH probe) so tests can stub it
 * without requiring any real binary to be installed.  This matches the
 * framework's injectable-`fetch` DIP pattern (`CoreBindings.FETCH`).
 *
 * `buildAugmentedPath` constructs a PATH string that PREPENDS the
 * `node_modules/.bin` directories walked up from a base directory
 * (and `process.cwd()`) to `process.env.PATH`.  This makes workspace-
 * installed adapters (devDependencies) discoverable and spawnable without
 * requiring a global install.
 */

import {execFile} from 'node:child_process';
import * as nodePath from 'node:path';
import {promisify} from 'node:util';
import {loggers} from '@agentback/common';
import type {AgentDescriptor} from './types.js';

export type {AgentDescriptor} from './types.js';

const log = loggers('agentback:console-chat:agents');

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Augmented PATH helper
// ---------------------------------------------------------------------------

/**
 * Builds an augmented PATH string by PREPENDING every `node_modules/.bin`
 * directory found along the walk from `baseDir` up to the filesystem root,
 * as well as from `process.cwd()` up, to `process.env.PATH`.
 *
 * This allows workspace-installed adapters (e.g. a devDependency in
 * `examples/hello-agent-console`) to be discovered and spawned without a
 * global install.  pnpm may hoist the bin under the workspace root's
 * `node_modules/.bin` and/or keep it under the example's own
 * `node_modules/.bin`; walking up from both `baseDir` and `cwd` handles both.
 *
 * @param baseDir - Root of the caller's package tree (e.g. the example root).
 *   Defaults to `process.cwd()` when omitted.
 * @returns A PATH string (OS separator) with local `.bin` dirs prepended.
 */
export function buildAugmentedPath(baseDir?: string): string {
  const globalPath = process.env['PATH'] ?? '';
  const dirs = new Set<string>();

  // Walk from both baseDir and process.cwd(), deduplicating entries.
  const roots = new Set<string>([process.cwd()]);
  if (baseDir) roots.add(baseDir);

  for (const root of roots) {
    let dir = root;
    while (true) {
      dirs.add(nodePath.join(dir, 'node_modules', '.bin'));
      const parent = nodePath.dirname(dir);
      if (parent === dir) break; // reached filesystem root
      dir = parent;
    }
  }

  const extra = [...dirs].join(nodePath.delimiter);
  return extra ? `${extra}${nodePath.delimiter}${globalPath}` : globalPath;
}

// ---------------------------------------------------------------------------
// Probe seam
// ---------------------------------------------------------------------------

/** Result returned by a `RunProbe` call. */
export interface ProbeResult {
  present: boolean;
  version?: string;
}

/**
 * Injectable probe function.  Receives the binary name (no args) and returns
 * whether the binary is on PATH and, if so, its reported version string.
 *
 * Default implementation runs `<bin> --version` via `execFile` and parses the
 * first semver-shaped token from stdout/stderr.
 */
export type RunProbe = (bin: string) => Promise<ProbeResult>;

/**
 * Real probe: runs `<bin> --version`, extracts the first `X.Y.Z` token.
 * Returns `{present: false}` when the binary is not found.
 *
 * Augments PATH with local `node_modules/.bin` directories so workspace-
 * installed adapters (devDependencies) are discoverable without a global
 * install.  Uses {@link buildAugmentedPath} with `process.cwd()` as the base.
 */
export function makeProbe(baseDir?: string): RunProbe {
  const PATH = buildAugmentedPath(baseDir);
  return async (bin: string): Promise<ProbeResult> => {
    try {
      const {stdout, stderr} = await execFileAsync(bin, ['--version'], {
        timeout: 5000,
        windowsHide: true,
        env: {...process.env, PATH},
      });
      const output = stdout || stderr || '';
      // Extract the first semver-like token (X.Y.Z or X.Y.Z-pre)
      const match = output.match(/(\d+\.\d+\.\d+[^\s]*)/);
      return {present: true, version: match?.[1]};
    } catch {
      return {present: false};
    }
  };
}

/**
 * Default probe — resolves the bin from the global PATH plus `node_modules/.bin`
 * dirs walked up from `process.cwd()`. For a workspace-installed (devDependency)
 * adapter whose bin is NOT under cwd (pnpm isolates it under the consuming
 * package), pass a `baseDir` via {@link makeProbe} (e.g. the app's own dir).
 */
export const defaultProbe: RunProbe = makeProbe();

// ---------------------------------------------------------------------------
// Built-in catalog
// ---------------------------------------------------------------------------

/**
 * The built-in agent catalog.  Seeded with the pinned `claude-agent-acp`
 * reference adapter (the ACP CLI wrapper for Claude Code).
 *
 * Confirmed live 2026-06-20: bin is `claude-agent-acp` (no extra flags needed);
 * the npm package providing the bin is `@agentclientprotocol/claude-agent-acp`.
 */
export const BUILTIN_AGENTS: AgentDescriptor[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    detect: {bin: 'claude-agent-acp'},
    command: ['claude-agent-acp'],
    installPackage: '@agentclientprotocol/claude-agent-acp',
  },
];

// ---------------------------------------------------------------------------
// Version comparison
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings (major.minor.patch only; pre-release ignored).
 * Returns true when `actual` satisfies `>= required`.
 */
function meetsMinVersion(actual: string, required: string): boolean {
  const parse = (v: string) =>
    v
      .split('.')
      .slice(0, 3)
      .map(p => parseInt(p, 10) || 0) as [number, number, number];

  const [ma, mi, pa] = parse(actual);
  const [mr, mir, pr] = parse(required);

  if (ma !== mr) return ma > mr;
  if (mi !== mir) return mi > mir;
  return pa >= pr;
}

// ---------------------------------------------------------------------------
// discoverAgents
// ---------------------------------------------------------------------------

/**
 * Probe each descriptor in `catalog` and return the subset that is present
 * and (if `detect.minVersion` is set) meets the minimum version.
 *
 * @param catalog   - Descriptors to probe; typically `BUILTIN_AGENTS`.
 * @param runProbe  - Injectable probe (default: {@link defaultProbe}).
 */
export async function discoverAgents(
  catalog: AgentDescriptor[],
  runProbe: RunProbe = defaultProbe,
): Promise<{id: string; name: string}[]> {
  const results: {id: string; name: string}[] = [];

  await Promise.all(
    catalog.map(async desc => {
      const probe = await runProbe(desc.detect.bin);
      if (!probe.present) {
        log.debug('agent %s not found on PATH', desc.id);
        return;
      }
      const min = desc.detect.minVersion;
      if (min && probe.version) {
        if (!meetsMinVersion(probe.version, min)) {
          log.debug(
            'agent %s found %s but need >= %s',
            desc.id,
            probe.version,
            min,
          );
          return;
        }
      } else if (min && !probe.version) {
        // Cannot determine version — treat as unsatisfied
        log.debug(
          'agent %s: version required (%s) but not detectable',
          desc.id,
          min,
        );
        return;
      }
      results.push({id: desc.id, name: desc.name});
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/** Result of a doctor check for a single agent. */
export interface DoctorResult {
  status: 'ok' | 'missing' | 'wrong-version';
  /** Detected version string (present when `status !== 'missing'`). */
  found?: string;
  /** Minimum required version (present when `status === 'wrong-version'`). */
  need?: string;
  /**
   * Copy-paste install/upgrade command the developer can run to fix the
   * problem (the F1 DX affordance).  Always non-empty.
   */
  fix: string;
}

/**
 * Run a diagnostic check for a single `AgentDescriptor`.
 *
 * - `ok`           — binary present and meets `minVersion` (if set).
 * - `missing`      — binary not found on PATH.
 * - `wrong-version` — binary present but version is below `minVersion`.
 *
 * `fix` is a copy-paste shell command the developer can run immediately.
 *
 * @param descriptor - The agent to check.
 * @param runProbe   - Injectable probe (default: {@link defaultProbe}).
 */
export async function doctor(
  descriptor: AgentDescriptor,
  runProbe: RunProbe = defaultProbe,
): Promise<DoctorResult> {
  const {id, detect} = descriptor;
  const bin = detect.bin;
  const min = detect.minVersion;

  // F1 fix line — a stable npm global install command.
  // Confirmed live 2026-06-20: the bin `claude-agent-acp` ships in the npm
  // package `@agentclientprotocol/claude-agent-acp` (not a same-name package).
  const fix = `npm install -g ${descriptor.installPackage ?? bin}`;

  const probe = await runProbe(bin);

  if (!probe.present) {
    log.debug('doctor(%s): missing', id);
    return {status: 'missing', fix};
  }

  if (min && !probe.version) {
    log.debug('doctor(%s): wrong-version found=undefined need=%s', id, min);
    return {status: 'wrong-version', found: undefined, need: min, fix};
  }

  if (min && probe.version && !meetsMinVersion(probe.version, min)) {
    log.debug(
      'doctor(%s): wrong-version found=%s need=%s',
      id,
      probe.version,
      min,
    );
    return {status: 'wrong-version', found: probe.version, need: min, fix};
  }

  log.debug('doctor(%s): ok version=%s', id, probe.version);
  return {status: 'ok', found: probe.version, fix};
}
