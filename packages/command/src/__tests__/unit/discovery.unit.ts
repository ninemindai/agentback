// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import type {ToolBinding} from '@agentback/mcp';
import {renderLlms, toolHelp, usage} from '../../discovery.js';

function bind(
  name: string,
  extra: Partial<ToolBinding['meta']> = {},
): ToolBinding {
  class C {}
  return {ctor: C, meta: {name, methodName: name, ...extra}} as unknown as ToolBinding;
}

describe('toolHelp', () => {
  const forecast = bind('forecast', {
    description: 'Weather forecast.',
    input: z.object({
      city: z.string().describe('City name'),
      days: z.number().default(1).describe('Days ahead'),
    }),
  });

  it('marks a plain field required', () => {
    expect(toolHelp(forecast)).toMatch(/--city <string> \(required\)/);
  });

  it('does NOT mark a defaulted field required, and shows the default', () => {
    const help = toolHelp(forecast);
    expect(help).not.toMatch(/--days.*\(required\)/);
    expect(help).toMatch(/--days <number> \(default: 1\)/);
  });

  it('reports no flags for an input-less tool', () => {
    expect(toolHelp(bind('ping'))).toMatch(/no flags/);
  });

  it('renders a positional field in the usage line and an Arguments section', () => {
    const t = bind('forecast', {
      input: z.object({
        city: z.string().meta({positional: true}).describe('City name'),
        days: z.number().default(1),
      }),
    });
    const help = toolHelp(t);
    expect(help).toMatch(/forecast <city> \[--flags\]/);
    expect(help).toMatch(/Arguments:/);
    expect(help).toMatch(/city <string> — City name/);
    // city is positional, so it must NOT appear as a --flag
    expect(help).not.toMatch(/--city/);
  });
});

describe('usage', () => {
  it('lists one line per command with its description', () => {
    const u = usage([bind('forecast', {description: 'Weather.'}), bind('geocode')]);
    expect(u).toMatch(/forecast — Weather\./);
    expect(u).toMatch(/geocode/);
  });
});

describe('renderLlms', () => {
  it('emits a manifest with each tool name + emitted input schema', () => {
    const manifest = JSON.parse(
      renderLlms([bind('forecast', {input: z.object({city: z.string()})})]),
    );
    expect(manifest.tools[0].name).toBe('forecast');
    expect(manifest.tools[0].inputSchema.properties.city.type).toBe('string');
  });
});
