// Copyright Zhaohui Feng 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ActorId, CommittedActorEvent} from '@agentback/actors';
import {loggers} from '@agentback/common';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';

const log = loggers('agentback:actors:redis:delivery');

/**
 * The reads one tail loop needs from the runtime that owns the journal. Keeps
 * the subscriber off `RedisActorRuntime`'s internals (and off its public
 * surface — the runtime builds this inline in `subscribe`).
 */
export interface JournalSource {
  /** Every identity that has ever taken a turn under this prefix. */
  identities(): Promise<readonly ActorId[]>;
  /** The Redis Stream key holding one identity's journal. */
  logKey(actor: ActorId): string;
  /** Rebuild one committed event from a stream entry's flat field list. */
  readEntry(actor: ActorId, fields: string[]): CommittedActorEvent;
}

export interface JournalSubscribeOptions {
  /** `XREAD BLOCK` window per poll in ms. Default 1000. */
  blockMs?: number;
  /** How often the identity index is re-read in ms. Default 1000. */
  discoveryIntervalMs?: number;
  /**
   * The last `seq` this consumer already handled for an identity, so a fresh
   * process resumes instead of replaying the whole log. The **consumer** owns
   * this cursor — nothing here persists one — and returning `undefined` (the
   * default) replays that identity from `seq` 0. Delivery is at-least-once
   * either way; the cursor only bounds how much is replayed.
   */
  since?: (actor: ActorId) => number | undefined;
}

type StreamEntry = [id: string, fields: string[] | null];
type StreamRead = Array<[key: string, entries: StreamEntry[]]> | null;

/** Never a real stream id, so `XREAD` from it returns the log from the start. */
const FROM_START = '0-0';

function actorKey(actor: ActorId): string {
  return `${actor.type}\u0000${actor.id}`;
}

/**
 * One tail loop over every identity journal under a prefix, feeding one
 * handler. Delivery is best effort and at-least-once: the durable Redis
 * Streams are the source of truth, this only pushes what it reads.
 *
 * The loop holds one dedicated connection (an `XREAD BLOCK` starves every
 * other command on its socket) and reads all known identity streams in a
 * single multi-stream `XREAD`. Two cursors do the work: the Redis entry id it
 * last read (where to resume the live read) and the last `seq` it delivered
 * per identity (what the consumer has already been offered). On a (re)connect
 * the entry ids are dropped and every identity is re-read from the start of
 * its log with the `seq` cursor filtering — the "replay by seq, then go live"
 * path, which is also what a restarted process does with an empty cursor map.
 *
 * There is deliberately **no filter between the log and the handler**: every
 * committed event of every identity reaches every subscription, and consumers
 * dedup by `(actor, seq)` themselves.
 *
 * Known limitation: the multi-stream `XREAD` spans identities, so on Redis
 * Cluster (where each identity's keys hash to its own slot) it would be a
 * cross-slot read. Delivery is single-node for now; the commit path is not.
 */
export class RedisJournalSubscription {
  /** Last `seq` handed to the handler, per identity. */
  private readonly cursors = new Map<string, number>();
  /** Last Redis entry id read, per identity. Cleared on reconnect. */
  private readonly positions = new Map<string, string>();
  private readonly actors = new Map<string, ActorId>();
  /** Reverse index of the above, to route one `XREAD` result back. */
  private readonly byStream = new Map<string, ActorId>();
  private readonly blockMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly since: (actor: ActorId) => number | undefined;
  private connection?: ReturnType<RedisConnectionManager['duplicate']>;
  private nextDiscovery = 0;
  private closed = false;
  private readonly done: Promise<void>;

  constructor(
    private readonly connections: RedisConnectionManager,
    private readonly source: JournalSource,
    private readonly handler: (event: CommittedActorEvent) => unknown,
    options: JournalSubscribeOptions = {},
  ) {
    // Guarded here as well as in the runtime's constructor: 0 would mean
    // "block forever" / "rediscover in a hot loop", and this class is
    // constructible directly and per-call-overridable.
    this.blockMs = positiveMs(options.blockMs ?? 1_000, 'blockMs');
    this.discoveryIntervalMs = positiveMs(
      options.discoveryIntervalMs ?? 1_000,
      'discoveryIntervalMs',
    );
    this.since = options.since ?? (() => undefined);
    this.done = this.loop();
  }

  /** Stop tailing and release the connection. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return this.done.then(() => undefined);
    this.closed = true;
    // Break the blocked XREAD so the loop can observe `closed`.
    this.connection?.disconnect();
    await this.done.catch(() => undefined);
    if (this.connection) await this.connections.release(this.connection);
    this.connection = undefined;
  }

  private async loop(): Promise<void> {
    while (!this.closed) {
      try {
        const conn = (this.connection ??= this.connections.duplicate());
        await this.discover();
        await this.replay(conn);
        if (this.closed) break;
        const keys = [...this.actors.keys()];
        if (!keys.length) {
          await sleep(this.discoveryIntervalMs);
          continue;
        }
        const read = (await conn.xread(
          'COUNT',
          64,
          'BLOCK',
          this.blockMs,
          'STREAMS',
          ...keys.map(key => this.source.logKey(this.actors.get(key)!)),
          ...keys.map(key => this.positions.get(key) ?? FROM_START),
        )) as StreamRead;
        for (const [streamKey, entries] of read ?? []) {
          const actor = this.byStream.get(streamKey);
          if (!actor) continue;
          for (const [id, fields] of entries) {
            if (this.closed) break;
            this.positions.set(actorKey(actor), id);
            if (fields) await this.offer(actor, fields);
          }
        }
      } catch (err) {
        if (this.closed) break;
        log.error('journal tail loop failed, replaying by seq: %s', err);
        // Whatever was in flight is unknown now: re-read each identity from
        // the start of its log and let the seq cursors suppress what was
        // already delivered.
        this.positions.clear();
        await sleep(100);
      }
    }
  }

  /** Re-read the identity index, at most every `discoveryIntervalMs`. */
  private async discover(): Promise<void> {
    if (Date.now() < this.nextDiscovery) return;
    this.nextDiscovery = Date.now() + this.discoveryIntervalMs;
    for (const actor of await this.source.identities()) {
      const key = actorKey(actor);
      if (this.actors.has(key)) continue;
      this.actors.set(key, actor);
      this.byStream.set(this.source.logKey(actor), actor);
    }
  }

  /**
   * Replay every identity that has no live read position — one newly
   * discovered, or all of them after a reconnect — from the start of its log,
   * delivering only what is past this subscription's `seq` cursor.
   */
  private async replay(
    conn: ReturnType<RedisConnectionManager['duplicate']>,
  ): Promise<void> {
    for (const [key, actor] of this.actors) {
      if (this.closed || this.positions.has(key)) continue;
      const entries = await conn.xrange(this.source.logKey(actor), '-', '+');
      this.positions.set(key, entries.at(-1)?.[0] ?? FROM_START);
      for (const [, fields] of entries) {
        if (this.closed) break;
        await this.offer(actor, fields);
      }
    }
  }

  /** Hand one journal entry to the handler unless the cursor covers it. */
  private async offer(actor: ActorId, fields: string[]): Promise<void> {
    const key = actorKey(actor);
    let event: CommittedActorEvent;
    try {
      event = this.source.readEntry(actor, fields);
    } catch (err) {
      // A foreign or malformed entry is skipped, never fatal to the tail.
      log.error(
        'journal entry for actor %s/%s could not be read: %s',
        actor.type,
        actor.id,
        err,
      );
      return;
    }
    const cursor = this.cursors.get(key) ?? this.since(actor) ?? -1;
    if (event.seq <= cursor) return;
    try {
      await this.handler(event);
    } catch (err) {
      // Best-effort live delivery: a broken consumer degrades to skip + log.
      // The event is not retried — the durable log is still there to replay.
      log.error(
        'subscriber threw on %s/%s#%d and was skipped: %s',
        actor.type,
        actor.id,
        event.seq,
        err,
      );
    }
    this.cursors.set(key, event.seq);
  }
}

function positiveMs(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
