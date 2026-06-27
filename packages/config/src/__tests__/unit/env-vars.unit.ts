// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {resolveEnvVars, resolveEnvVarsInObject} from '../../env-vars.js';

describe('resolveEnvVars', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.FOO = process.env.FOO;
    saved.BAR = process.env.BAR;
    process.env.FOO = 'foo-value';
    delete process.env.BAR;
  });
  afterEach(() => {
    if (saved.FOO === undefined) delete process.env.FOO;
    else process.env.FOO = saved.FOO;
    if (saved.BAR === undefined) delete process.env.BAR;
    else process.env.BAR = saved.BAR;
  });

  it('substitutes set vars', () => {
    expect(resolveEnvVars('hello ${FOO}')).toBe('hello foo-value');
  });

  it('honors :- defaults when the var is missing', () => {
    expect(resolveEnvVars('${BAR:-fallback}')).toBe('fallback');
  });

  it('supports empty defaults', () => {
    expect(resolveEnvVars('${BAR:-}')).toBe('');
  });

  it('throws on a missing var with no default', () => {
    expect(() => resolveEnvVars('${BAR}')).toThrow(/BAR/);
  });

  it('walks objects and arrays recursively', () => {
    const out = resolveEnvVarsInObject({
      a: '${FOO}',
      b: ['${FOO}', '${BAR:-x}', 42, true],
      c: {nested: '${FOO}'},
    });
    expect(out).toEqual({
      a: 'foo-value',
      b: ['foo-value', 'x', 42, true],
      c: {nested: 'foo-value'},
    });
  });
});
