// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {fromDisk, fromCdn} from '../../host/asset-source.js';

describe('fromDisk', () => {
  let dir: string;
  beforeEach(() => {dir = mkdtempSync(path.join(tmpdir(), 'asset-'));});
  afterEach(() => rmSync(dir, {recursive: true, force: true}));

  it('serves an existing file with a content-type', async () => {
    writeFileSync(path.join(dir, 'main.js'), 'console.log(1)');
    const res = await fromDisk(dir)('/main.js');
    expect(res?.status).toBe(200);
    expect(res?.headers.get('content-type')).toContain('javascript');
  });

  it('returns undefined for a missing file', async () => {
    expect(await fromDisk(dir)('/nope.js')).toBeUndefined();
  });

  it('rejects path traversal', async () => {
    expect(await fromDisk(dir)('/../secret')).toBeUndefined();
  });
});

describe('fromCdn', () => {
  it('proxies an asset from the CDN base', async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: any) => {
      calls.push(String(u));
      return new Response('body', {status: 200, headers: {'content-type': 'application/javascript'}});
    }) as unknown as typeof fetch;
    const res = await fromCdn('https://cdn.example/npm/pkg@1/dist', fetchFn)('/main.js');
    expect(calls[0]).toBe('https://cdn.example/npm/pkg@1/dist/main.js');
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe('body');
  });

  it('returns undefined when the CDN 404s', async () => {
    const fetchFn = (async () => new Response('', {status: 404})) as unknown as typeof fetch;
    expect(await fromCdn('https://cdn.example/x', fetchFn)('/missing.js')).toBeUndefined();
  });

  it('rejects a protocol-relative suffix and does not call fetch', async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: any) => {
      calls.push(String(u));
      return new Response('', {status: 200, headers: {'content-type': 'application/javascript'}});
    }) as unknown as typeof fetch;
    const res = await fromCdn('https://cdn.example/npm/pkg@1/dist', fetchFn)('//evil.com/x');
    expect(res).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('rejects a traversal suffix and does not call fetch', async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: any) => {
      calls.push(String(u));
      return new Response('', {status: 200, headers: {'content-type': 'application/javascript'}});
    }) as unknown as typeof fetch;
    const res = await fromCdn('https://cdn.example/npm/pkg@1/dist', fetchFn)('/a/../../etc/passwd');
    expect(res).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('rejects a suffix that resolves off-origin and does not call fetch', async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: any) => {
      calls.push(String(u));
      return new Response('', {status: 200, headers: {'content-type': 'application/javascript'}});
    }) as unknown as typeof fetch;
    // Construct a suffix that, when appended to the base, changes the origin.
    // URL parsing: new URL('https://cdn.example/npm/pkg@1/dist/x@evil.com/y')
    // keeps the same origin, so instead we test an encoded absolute URL embedded
    // as a path that resolves outside the base path via dot-segments.
    // Use encoded '..' to attempt bypass via URL resolution.
    const res = await fromCdn('https://cdn.example/npm/pkg@1/dist', fetchFn)('/%2e%2e/%2e%2e/secret');
    expect(res).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('returns undefined for a 200 with content-type text/html (not served)', async () => {
    const calls: string[] = [];
    const fetchFn = (async (u: any) => {
      calls.push(String(u));
      return new Response('<html></html>', {status: 200, headers: {'content-type': 'text/html; charset=utf-8'}});
    }) as unknown as typeof fetch;
    const res = await fromCdn('https://cdn.example/npm/pkg@1/dist', fetchFn)('/index.html');
    expect(res).toBeUndefined();
    // fetch WAS called (blocked after response, not before)
    expect(calls).toHaveLength(1);
  });
});
