// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {appendFile, readFile} from 'node:fs/promises';
import type {UsageEvent, UsageSink} from './types.js';

/**
 * Durable {@link UsageSink} that appends each event as one JSON line to a file
 * — an append-only audit log (the rung-1 asset) that survives restarts. Reads
 * replay the whole file; for high volume, point this at a log shipper or swap
 * for a streaming sink. Idempotency is enforced per-instance (a process that
 * re-records the same id skips the duplicate write); cross-restart dedup is the
 * downstream store's job, since an append-only audit deliberately keeps every
 * line it was given.
 */
export class JsonlUsageSink implements UsageSink {
  private readonly seen = new Set<string>();

  constructor(private readonly filePath: string) {}

  async record(event: UsageEvent): Promise<void> {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`);
  }

  /** Replay every event from the log. Missing file → empty list. */
  async read(): Promise<UsageEvent[]> {
    let data: string;
    try {
      data = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as {code?: string}).code === 'ENOENT') return [];
      throw err;
    }
    return data
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as UsageEvent);
  }
}
