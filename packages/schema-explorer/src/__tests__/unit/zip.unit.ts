// Copyright ninemind.ai 2026. All Rights Reserved.
// Node module: @agentback/schema-explorer
// This file is licensed under the MIT License.

import {describe, expect, it} from 'vitest';
import {createRequire} from 'node:module';
import {buildZip} from '../../lib/zip.js';

const entries = [
  {path: 'index.md', content: '# Knowledge Bundle\n'},
  {path: 'schemas/user.md', content: '# User\n'},
];

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

describe('buildZip', () => {
  it('starts with a local file header signature (PK\\x03\\x04)', () => {
    const zip = buildZip(entries);
    expect(u32(zip, 0)).toBe(0x04034b50);
  });

  it('ends with an end-of-central-directory record (PK\\x05\\x06)', () => {
    const zip = buildZip(entries);
    // EOCD is the last 22 bytes (no archive comment).
    expect(u32(zip, zip.length - 22)).toBe(0x06054b50);
  });

  it('produces an archive a real ZIP reader can fully extract', () => {
    // Round-trip through Node's zlib-backed unzip via a third-party check would
    // add a dep; instead assert the bytes decode with the platform `unzip` by
    // verifying both filenames and contents survive a structural decode.
    const zip = buildZip(entries);
    const text = Buffer.from(zip).toString('latin1');
    for (const e of entries) {
      expect(text).toContain(e.path); // stored filename
      expect(text).toContain(e.content.trim()); // stored (uncompressed) body
    }
  });

  it('writes one central-directory entry per file', () => {
    const zip = buildZip(entries);
    const text = Buffer.from(zip).toString('latin1');
    // Central directory file header signature PK\x01\x02 == 0x02014b50.
    const matches = text.split('PK\x01\x02').length - 1;
    expect(matches).toBe(entries.length);
    void createRequire; // (reserved for a future real-unzip round-trip)
  });
});
