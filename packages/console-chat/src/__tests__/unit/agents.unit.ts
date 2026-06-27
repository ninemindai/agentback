// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import {describe, expect, it, afterEach} from 'vitest';
import {
  BUILTIN_AGENTS,
  buildAugmentedPath,
  discoverAgents,
  doctor,
} from '../../agents.js';
import type {AgentDescriptor, RunProbe} from '../../agents.js';

// --- stub probes ----------------------------------------------------------

const presentProbe: RunProbe = async () => ({present: true, version: '1.2.3'});
const missingProbe: RunProbe = async () => ({present: false});
const oldVersionProbe: RunProbe = async () => ({present: true, version: '0.0.1'});

// A descriptor that requires a minimum version
const descriptor: AgentDescriptor = {
  id: 'claude-code',
  name: 'Claude Code',
  detect: {bin: 'claude-agent-acp', minVersion: '1.0.0'},
  command: ['claude-agent-acp'],
};

// A descriptor with no minimum version requirement
const descriptorNoMin: AgentDescriptor = {
  id: 'claude-code',
  name: 'Claude Code',
  detect: {bin: 'claude-agent-acp'},
  command: ['claude-agent-acp'],
};

// --- BUILTIN_AGENTS -------------------------------------------------------

describe('BUILTIN_AGENTS', () => {
  it('contains at least the claude-code entry', () => {
    const cc = BUILTIN_AGENTS.find(a => a.id === 'claude-code');
    expect(cc).toBeDefined();
    expect(cc!.detect.bin).toBe('claude-agent-acp');
    expect(cc!.command).toContain('claude-agent-acp');
    // The bin ships in @agentclientprotocol/claude-agent-acp (confirmed live 2026-06-20)
    expect(cc!.installPackage).toBe('@agentclientprotocol/claude-agent-acp');
  });

  it('doctor on the claude-code entry produces the correct npm install command', async () => {
    const cc = BUILTIN_AGENTS.find(a => a.id === 'claude-code')!;
    const result = await doctor(cc, missingProbe);
    expect(result.fix).toBe('npm install -g @agentclientprotocol/claude-agent-acp');
  });
});

// --- discoverAgents -------------------------------------------------------

describe('discoverAgents', () => {
  it('returns present agents', async () => {
    const result = await discoverAgents([descriptor], presentProbe);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({id: 'claude-code', name: 'Claude Code'});
  });

  it('omits missing agents', async () => {
    const result = await discoverAgents([descriptor], missingProbe);
    expect(result).toHaveLength(0);
  });

  it('omits agents with version below minVersion', async () => {
    const result = await discoverAgents([descriptor], oldVersionProbe);
    expect(result).toHaveLength(0);
  });

  it('includes agent with no minVersion even if version is absent', async () => {
    const noVersionProbe: RunProbe = async () => ({present: true});
    const result = await discoverAgents([descriptorNoMin], noVersionProbe);
    expect(result).toHaveLength(1);
  });

  it('handles an empty catalog', async () => {
    const result = await discoverAgents([], presentProbe);
    expect(result).toHaveLength(0);
  });
});

// --- doctor ---------------------------------------------------------------

describe('doctor', () => {
  it('returns ok when binary is present and meets version', async () => {
    const result = await doctor(descriptor, presentProbe);
    expect(result.status).toBe('ok');
    expect(result.found).toBe('1.2.3');
    expect(result.fix).toBeTruthy();
  });

  it('returns missing when binary is not on PATH', async () => {
    const result = await doctor(descriptor, missingProbe);
    expect(result.status).toBe('missing');
    expect(result.found).toBeUndefined();
    expect(result.need).toBeUndefined();
    expect(result.fix).toBeTruthy();
    // fix must be a copy-pasteable install command using the npm package name
    expect(result.fix).toContain('claude-agent-acp');
  });

  it('returns wrong-version when version is below minVersion', async () => {
    const result = await doctor(descriptor, oldVersionProbe);
    expect(result.status).toBe('wrong-version');
    expect(result.found).toBe('0.0.1');
    expect(result.need).toBe('1.0.0');
    expect(result.fix).toBeTruthy();
    expect(result.fix).toContain('claude-agent-acp');
  });

  it('returns ok when present with no minVersion', async () => {
    const result = await doctor(descriptorNoMin, presentProbe);
    expect(result.status).toBe('ok');
  });

  it('returns ok when present and no version info available (no minVersion)', async () => {
    const noVersionProbe: RunProbe = async () => ({present: true});
    const result = await doctor(descriptorNoMin, noVersionProbe);
    expect(result.status).toBe('ok');
    expect(result.found).toBeUndefined();
  });

  it('returns wrong-version when minVersion is set but version is not detectable', async () => {
    const noVersionProbe: RunProbe = async () => ({present: true});
    const result = await doctor(descriptor, noVersionProbe);
    expect(result.status).toBe('wrong-version');
    expect(result.found).toBeUndefined();
    expect(result.need).toBe('1.0.0');
    expect(result.fix).toBeTruthy();
    expect(result.fix).toContain('claude-agent-acp');
  });
});

// --- buildAugmentedPath ---------------------------------------------------

describe('buildAugmentedPath', () => {
  // Track temp dirs so we can clean up after each test.
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        fs.rmSync(d, {recursive: true, force: true});
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  /** Create a temp dir with a fake `node_modules/.bin/<bin>` file. */
  function makeFakeBin(bin: string): {tmpDir: string; binPath: string} {
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'agentback-test-'));
    tmpDirs.push(tmpDir);
    const dotBin = nodePath.join(tmpDir, 'node_modules', '.bin');
    fs.mkdirSync(dotBin, {recursive: true});
    const binPath = nodePath.join(dotBin, bin);
    fs.writeFileSync(binPath, '#!/bin/sh\necho "fake"\n', {mode: 0o755});
    return {tmpDir, binPath};
  }

  it('includes node_modules/.bin from the base dir in the augmented PATH', () => {
    const {tmpDir} = makeFakeBin('my-test-bin');
    const augmented = buildAugmentedPath(tmpDir);
    const expected = nodePath.join(tmpDir, 'node_modules', '.bin');
    expect(augmented).toContain(expected);
  });

  it('prepends local .bin dirs before the global PATH', () => {
    const {tmpDir} = makeFakeBin('my-test-bin');
    const augmented = buildAugmentedPath(tmpDir);
    const globalPath = process.env['PATH'] ?? '';
    const globalIndex = augmented.indexOf(globalPath);
    const localBin = nodePath.join(tmpDir, 'node_modules', '.bin');
    const localIndex = augmented.indexOf(localBin);
    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(globalIndex).toBeGreaterThan(localIndex);
  });

  it('includes node_modules/.bin dirs walked up from the base dir', () => {
    // Create a nested structure: tmpDir/a/b — baseDir is a/b, but the .bin
    // is at tmpDir/node_modules/.bin (simulating a workspace root hoist).
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'agentback-test-'));
    tmpDirs.push(tmpDir);
    const nestedDir = nodePath.join(tmpDir, 'a', 'b');
    fs.mkdirSync(nestedDir, {recursive: true});
    // Place .bin at the top-level tmpDir (like a workspace root hoist).
    const dotBin = nodePath.join(tmpDir, 'node_modules', '.bin');
    fs.mkdirSync(dotBin, {recursive: true});
    const augmented = buildAugmentedPath(nestedDir);
    expect(augmented).toContain(dotBin);
  });

  it('discovery finds a bin present in a fake node_modules/.bin via the probe seam', async () => {
    const {tmpDir} = makeFakeBin('claude-agent-acp');

    // Stub probe: returns present when the binary exists under tmpDir's .bin.
    // This mirrors what defaultProbe does with the augmented PATH — we test
    // the helper via the injectable RunProbe seam so the test is deterministic
    // and not dependent on what is globally installed.
    const stubProbe: RunProbe = async (bin: string) => {
      const binPath = nodePath.join(
        tmpDir,
        'node_modules',
        '.bin',
        bin,
      );
      const exists = fs.existsSync(binPath);
      return {present: exists, version: exists ? '0.48.0' : undefined};
    };

    const found = await discoverAgents(BUILTIN_AGENTS, stubProbe);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({id: 'claude-code'});
  });
});
