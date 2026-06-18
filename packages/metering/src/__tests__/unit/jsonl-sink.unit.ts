// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect, afterEach} from 'vitest';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {JsonlUsageSink} from '../../jsonl-sink.js';
import type {UsageEvent} from '../../types.js';

const paths: string[] = [];
function tmpFile(): string {
  const p = join(tmpdir(), `usage-${randomUUID()}.jsonl`);
  paths.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(paths.splice(0).map(p => rm(p, {force: true})));
});

const event = (id: string, principalId = 'svc-1'): UsageEvent => ({
  id,
  at: '2026-06-08T00:00:00.000Z',
  status: 'ok',
  latencyMs: 5,
  units: 1,
  surface: 'rest',
  operation: 'WidgetController.list',
  principal: {kind: 'client', id: principalId},
});

describe('JsonlUsageSink', () => {
  it('appends events and reads them back', async () => {
    const sink = new JsonlUsageSink(tmpFile());
    await sink.record(event('a'));
    await sink.record(event('b', 'alice'));
    const events = await sink.read();
    expect(events.map(e => e.id)).toEqual(['a', 'b']);
    expect(events[1].principal.id).toBe('alice');
  });

  it('persists across instances (durable)', async () => {
    const path = tmpFile();
    await new JsonlUsageSink(path).record(event('persisted'));
    // A fresh instance with no in-memory state still sees the event on disk.
    const reloaded = await new JsonlUsageSink(path).read();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe('persisted');
  });

  it('is idempotent on event id within an instance', async () => {
    const sink = new JsonlUsageSink(tmpFile());
    await sink.record(event('dup'));
    await sink.record(event('dup'));
    expect(await sink.read()).toHaveLength(1);
  });

  it('returns an empty list when the log file does not exist yet', async () => {
    const sink = new JsonlUsageSink(tmpFile());
    expect(await sink.read()).toEqual([]);
  });
});
