// Copyright Zhaohui Feng 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import type {NanoReplayStore} from './nano.js';

const BLOCK_HASH_RE = /^[0-9A-F]{64}$/;

/**
 * A {@link NanoReplayStore} kept in an append-only file, so a block that paid
 * before a restart is still refused after it. Each claim is one line (the
 * upper-case block hash), written and flushed to disk before `claim` returns
 * `true`. Claims are kept forever, so `retentionSeconds` is unset and any
 * `maxTimeoutSeconds` is allowed. Only `node:fs` is used.
 *
 * One process owns a file: the claimed set is held in memory and `claim` is
 * atomic within the process (it runs synchronously). Several instances behind
 * a load balancer need a shared store instead (a unique-keyed table, or Redis
 * `SET key 1 NX`).
 *
 * A last line cut short by a crash during a write is dropped when the file is
 * opened again: its claim never completed, so `settle` never granted that
 * call. Any other line that is not a block hash throws, so a damaged file
 * stops the server at boot instead of silently forgetting claims.
 */
export class FileNanoReplayStore implements NanoReplayStore {
  private readonly used = new Set<string>();
  /** Set when a failed write could not be cut back; no further writes. */
  private damaged = false;

  constructor(private readonly path: string) {
    if (!existsSync(path)) {
      appendDurably(path, '');
      return;
    }
    const lines = readFileSync(path, 'utf8').split('\n');
    const unterminated = lines.pop() ?? '';
    lines.forEach((line, i) => {
      if (!BLOCK_HASH_RE.test(line)) {
        throw new Error(
          `FileNanoReplayStore: ${path} line ${i + 1} is not a block hash`,
        );
      }
      this.used.add(line);
    });
    if (unterminated !== '' || lines.length !== this.used.size) {
      rewrite(path, this.used);
    }
  }

  has(blockHash: string): boolean {
    return this.used.has(blockHash);
  }

  claim(blockHash: string): boolean {
    if (!BLOCK_HASH_RE.test(blockHash)) {
      throw new Error('FileNanoReplayStore: not an upper-case block hash');
    }
    if (this.used.has(blockHash)) return false;
    if (this.damaged) {
      throw new Error(
        `FileNanoReplayStore: an earlier write to ${this.path} failed; ` +
          'restart to recover',
      );
    }
    try {
      appendDurably(this.path, `${blockHash}\n`);
    } catch (err) {
      if ((err as {nanoClaimsTorn?: boolean}).nanoClaimsTorn) {
        this.damaged = true;
      }
      throw err;
    }
    this.used.add(blockHash);
    return true;
  }
}

/** Write all of `bytes` to `fd`, looping over short writes. */
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const n = writeSync(fd, bytes, offset, bytes.length - offset);
    if (n <= 0) throw new Error('FileNanoReplayStore: write made no progress');
    offset += n;
  }
}

/**
 * Append `text` and flush it. If the write or the flush fails, the file is
 * cut back to its previous length so no partial line precedes the next
 * append; when that also fails the error carries `nanoClaimsTorn: true`.
 */
function appendDurably(path: string, text: string): void {
  const fd = openSync(path, 'a', 0o600);
  try {
    const before = fstatSync(fd).size;
    try {
      writeAll(fd, Buffer.from(text, 'utf8'));
      fsyncSync(fd);
    } catch (err) {
      let torn = false;
      try {
        ftruncateSync(fd, before);
        fsyncSync(fd);
      } catch {
        torn = true;
      }
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        nanoClaimsTorn: torn,
      });
    }
  } finally {
    closeSync(fd);
  }
}

/** Replace the file with one line per claim, atomically. */
function rewrite(path: string, hashes: Iterable<string>): void {
  let text = '';
  for (const hash of hashes) text += `${hash}\n`;
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeAll(fd, Buffer.from(text, 'utf8'));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}
