// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {
  BUILTIN_AGENTS,
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
    // fix must be a copy-pasteable install command
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
