// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {generateEntry} from '../../generate-entry.js';

describe('generateEntry', () => {
  const src = generateEntry({entry: '../dist/main.js', exportName: 'buildApp'});

  it('imports the resolved builder and entry path', () => {
    expect(src).toContain("import {buildApp} from '../dist/main.js'");
  });

  it('uses Node http types, never @vercel/node', () => {
    expect(src).toContain("from 'node:http'");
    expect(src).not.toContain('@vercel/node');
  });

  it('memoizes the boot and hands Vercel the express app', () => {
    expect(src).toContain('??=');
    expect(src).toContain('restServer');
    expect(src).toContain('expressApp');
    expect(src).toContain('listen: false');
  });

  it('exports a default handler', () => {
    expect(src).toContain('export default async function handler');
  });
});
