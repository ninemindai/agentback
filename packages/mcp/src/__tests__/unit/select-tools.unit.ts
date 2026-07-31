// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {authorize} from '@agentback/authorization';
import {selectTools} from '../../select-tools.js';
import type {ToolBinding} from '../../mcp.server.js';

// selectTools is the transport-neutral tool filter shared by the AI SDK
// projection (@agentback/agents) and the CLI projection (@agentback/command)
// — eng review T3 / outside voice finding 5. It does everything EXCEPT the
// AI-provider tool-name regex, which stays in @agentback/agents.

function bind(
  name: string,
  meta: Partial<ToolBinding['meta']> = {},
): ToolBinding {
  class C {}
  return {
    ctor: C,
    meta: {name, methodName: name, ...meta},
  } as unknown as ToolBinding;
}

function scopedBind(name: string, scopes: string[]): ToolBinding {
  @authorize({scopes})
  class C {}
  return {ctor: C, meta: {name, methodName: name}} as unknown as ToolBinding;
}

describe('selectTools', () => {
  const all = [bind('echo'), bind('open'), bind('dangerous', {confirm: true})];

  it('excludes confirm: tools by default', () => {
    expect(selectTools(all).map(t => t.meta.name)).toEqual(['echo', 'open']);
  });

  it('include filters by name', () => {
    expect(selectTools(all, {include: ['echo']}).map(t => t.meta.name)).toEqual(
      ['echo'],
    );
  });

  it('exclude filters by name', () => {
    expect(selectTools(all, {exclude: ['echo']}).map(t => t.meta.name)).toEqual(
      ['open'],
    );
  });

  it('throws on duplicate tool names', () => {
    expect(() => selectTools([bind('dup'), bind('dup')])).toThrow(
      /duplicate tool name\(s\): dup/,
    );
  });

  it('throws when include names an unmatched (registered) tool, listing available', () => {
    expect(() => selectTools(all, {include: ['ecoh']})).toThrow(
      /match no registered tool: ecoh.*Available: .*echo/s,
    );
  });

  it('throws when an include list names a confirm: tool', () => {
    expect(() => selectTools(all, {include: ['dangerous']})).toThrow(
      /confirm: tool/,
    );
  });

  it('scope gate hides tools whose required scopes are not held', () => {
    const scoped = [bind('echo'), scopedBind('admin_op', ['admin:ops'])];
    expect(
      selectTools(scoped, {scopes: ['other']}).map(t => t.meta.name),
    ).toEqual(['echo']);
  });

  it('says "visible" (not "registered") when a scope gate is active', () => {
    const scoped = [bind('echo'), scopedBind('admin_op', ['admin:ops'])];
    expect(() =>
      selectTools(scoped, {scopes: ['other'], include: ['admin_op']}),
    ).toThrow(/match no visible tool/);
  });
});
