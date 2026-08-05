// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  ACTOR_RUNTIME,
  SEAT_JOURNAL_CONSUMER,
  SeatJournalConsumerContract,
  collectValidatedExtensions,
  dispatchToExtensions,
  type ActorEventStore,
  type ActorId,
  type ActorRuntime,
  type CommittedActorEvent,
  type SeatJournalConsumerProvider,
} from '@agentback/actors';
import {loggers} from '@agentback/common';
import {
  BindingScope,
  ContextTags,
  ContextView,
  extensions,
  inject,
  lifeCycleObserver,
  type LifeCycleObserver,
} from '@agentback/core';
import type {RedisConnectionManager} from '@agentback/messaging-bullmq';
import {REDIS_ACTOR_CONNECTIONS, REDIS_ACTOR_OPTIONS} from './keys.js';
import {
  DEFAULT_ACTOR_PREFIX,
  type RedisActorRuntimeOptions,
} from './redis-actor-runtime.js';

const log = loggers('agentback:actors:redis:delivery');

export const SEAT_JOURNAL_CONSUMER_HOST_KEY = 'observers.SeatJournalConsumers';

/** The `type:id` member form the identity index already uses. */
function identityMember(actor: ActorId): string {
  return `${encodeURIComponent(actor.type)}:${encodeURIComponent(actor.id)}`;
}

/**
 * Host for the `seat.journal.consumer` extension point.
 *
 * The relationship to `subscribe()` is one-directional on purpose: **the host
 * consumes via `subscribe`**, it is not a second delivery path. One
 * subscription (one tail loop, one Redis connection) fans every committed
 * event out to every DI-registered consumer, so adding a provider costs a
 * callback rather than a connection, and `subscribe(fn)` stays the
 * programmatic surface for callers that are not extensions. Nothing filters
 * between the two: every consumer is offered every event and dedups by
 * `(actor, seq)` itself.
 *
 * The Task 0a discipline applies at both ends. Providers are Zod-validated
 * when they are discovered — a malformed one is excluded, never thrown — and
 * a validated provider that throws mid-delivery degrades to skip + log
 * without touching its siblings or the tail loop. The view is reactive, so a
 * provider plugged in after start is picked up on the next event.
 *
 * **Cursors are persisted per consumer id**, which is what keeps a restart
 * from replaying every identity's whole history to every consumer. The
 * provider name from the extension contract is that id (it is stable — it is
 * the same string the degrade paths log), and each one owns a Redis hash of
 * `identity -> last delivered seq` beside the journals it reads.
 *
 * This is a cursor, not a broker: no consumer groups, no acks, no
 * redelivery bookkeeping. The cursor is written *after* the handler returns,
 * so the semantics stay **at-least-once** — a crash between handling an event
 * and recording it redelivers that event on the next boot, which is precisely
 * what "be idempotent by `(actor, seq)`" is for. A consumer id the store has
 * never seen starts from `seq` 0, i.e. the behavior before cursors existed.
 */
@lifeCycleObserver('20-seat-journal-consumers', {
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: SEAT_JOURNAL_CONSUMER_HOST_KEY},
})
export class SeatJournalConsumerHost implements LifeCycleObserver {
  private providers: SeatJournalConsumerProvider[] = [];
  /** `provider id -> identity member -> last seq handed to that provider`. */
  private readonly cursors = new Map<string, Map<string, number>>();
  /**
   * `provider id -> identity member -> last seq *offered* to that provider`,
   * in this process only. Deliberately separate from `cursors`, which is the
   * persisted record of what was successfully handled: the difference between
   * the two is what distinguishes a consumer that was offered an event and
   * threw from one that was never offered it because retention deleted it.
   */
  private readonly offered = new Map<string, Map<string, number>>();
  private stale = true;
  private started = false;
  private unsubscribe?: () => void;
  private readonly prefix: string;

  constructor(
    @extensions.view(SEAT_JOURNAL_CONSUMER)
    private readonly consumers: ContextView<object>,
    @inject(ACTOR_RUNTIME) private readonly runtime: ActorRuntime,
    @inject(REDIS_ACTOR_CONNECTIONS)
    private readonly connections: RedisConnectionManager,
    @inject(REDIS_ACTOR_OPTIONS, {optional: true})
    options: RedisActorRuntimeOptions = {},
  ) {
    this.prefix = options.prefix ?? DEFAULT_ACTOR_PREFIX;
    this.consumers.on('refresh', () => {
      this.stale = true;
      // A provider plugged in after start must not need a restart to be fed.
      void this.sync().catch(err =>
        log.error(
          "extension point '%s': re-reading providers failed: %s",
          SEAT_JOURNAL_CONSUMER,
          err,
        ),
      );
    });
  }

  async start(): Promise<void> {
    this.started = true;
    await this.sync();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Match the subscription to the provider set. The tail loop costs a Redis
   * connection, so an app with no journal consumer bound never opens one —
   * the first provider to appear is what starts it.
   */
  private async sync(): Promise<void> {
    if (!this.started) return;
    await this.refresh();
    if (!this.providers.length || this.unsubscribe) return;
    const store = this.runtime as Partial<ActorEventStore>;
    if (typeof store.subscribe !== 'function') {
      // A runtime with no delivery half is a legitimate configuration, but
      // consumers bound against it would silently never run.
      log.warn(
        "extension point '%s': the bound ActorRuntime does not deliver events; %d consumer(s) will not run.",
        SEAT_JOURNAL_CONSUMER,
        this.providers.length,
      );
      return;
    }
    // The subscription is shared, so it must read from the *earliest* thing
    // any provider still needs; each provider then filters to its own cursor
    // in `deliver`. Typed as `ActorEventStore['subscribe']`, which takes no
    // options — the runtime's own signature does, so reach it through the
    // concrete shape rather than widening the port for one caller.
    this.unsubscribe = (store.subscribe as RedisEventSubscribe)(
      event => this.deliver(event),
      {
        since: actor => this.earliestCursor(actor),
      },
    );
  }

  /**
   * The lowest cursor across providers, or `undefined` when any provider has
   * none — that one needs the whole retained log, and the per-provider filter
   * below keeps the others from seeing it twice.
   */
  private earliestCursor(actor: ActorId): number | undefined {
    const member = identityMember(actor);
    let earliest: number | undefined;
    for (const provider of this.providers) {
      const cursor = this.cursors.get(provider.provider)?.get(member);
      if (cursor === undefined) return undefined;
      earliest = earliest === undefined ? cursor : Math.min(earliest, cursor);
    }
    return earliest;
  }

  /**
   * Returned to the tail loop, which awaits it — so one slow consumer slows
   * only this loop, never the committing turn (delivery is entirely read
   * side), and per-identity order is preserved for everyone.
   */
  private async deliver(event: CommittedActorEvent): Promise<void> {
    if (this.stale) await this.refresh();
    const member = identityMember(event.actor);
    await dispatchToExtensions(
      this.providers,
      SEAT_JOURNAL_CONSUMER,
      async provider => {
        const cursors = this.cursorsFor(provider.provider);
        const offered = this.offeredFor(provider.provider);
        const cursor = cursors.get(member);
        const lastOffered = offered.get(member);
        offered.set(member, event.seq);
        if (cursor !== undefined && event.seq <= cursor) return;
        // A jump past the cursor is only a *retention* gap if this consumer
        // was never offered the events in between. A consumer whose handler
        // threw also leaves its cursor behind while the log keeps moving, and
        // those events are still there to be replayed — warning about them
        // would send an operator after data loss that has not happened, on a
        // path that already logs its own error. Tracking what was offered is
        // the cheap way to tell the two apart: one Map, no extra Redis I/O,
        // and no reliance on the runtime exposing an "oldest retained seq".
        if (
          cursor !== undefined &&
          event.seq > cursor + 1 &&
          (lastOffered === undefined || lastOffered < event.seq - 1)
        ) {
          // Said once: the cursor advances to this event, so the next one is
          // contiguous.
          log.warn(
            "seat.journal.consumer '%s' resumed %s/%s at seq %d with a cursor at %d: the events between were never offered to it and are no longer in the log, so they will not be delivered.",
            provider.provider,
            event.actor.type,
            event.actor.id,
            event.seq,
            cursor,
          );
        }
        // The cursor is written only once the handler has returned. A throw
        // propagates to `dispatchToExtensions` (skip + log) leaving the cursor
        // where it was, so the event comes back on the next replay.
        await provider.consume(event);
        cursors.set(member, event.seq);
        await this.persistCursor(provider.provider, member, event.seq);
      },
    );
  }

  private cursorsFor(provider: string): Map<string, number> {
    let cursors = this.cursors.get(provider);
    if (!cursors) {
      cursors = new Map();
      this.cursors.set(provider, cursors);
    }
    return cursors;
  }

  private offeredFor(provider: string): Map<string, number> {
    let offered = this.offered.get(provider);
    if (!offered) {
      offered = new Map();
      this.offered.set(provider, offered);
    }
    return offered;
  }

  /**
   * Best effort, and deliberately not the provider's problem: a failed write
   * costs a redelivery on the next boot, which the at-least-once contract
   * already allows. Reporting it as the provider throwing would blame the
   * wrong component.
   */
  private async persistCursor(
    provider: string,
    member: string,
    seq: number,
  ): Promise<void> {
    try {
      await this.connections.base.hset(
        this.cursorKey(provider),
        member,
        String(seq),
      );
    } catch (err) {
      log.error(
        "seat.journal.consumer '%s': could not persist its cursor at %s#%d; the event may be redelivered: %s",
        provider,
        member,
        seq,
        err,
      );
    }
  }

  private cursorKey(provider: string): string {
    return `${this.prefix}:consumers:${encodeURIComponent(provider)}`;
  }

  private async refresh(): Promise<void> {
    this.stale = false;
    this.providers = await collectValidatedExtensions(
      this.consumers,
      SEAT_JOURNAL_CONSUMER,
      SeatJournalConsumerContract,
    );
    for (const provider of this.providers) {
      if (this.cursors.has(provider.provider)) continue;
      this.cursors.set(provider.provider, await this.loadCursors(provider));
    }
  }

  /**
   * One consumer's persisted cursors. A read failure degrades to "no cursors"
   * — a full replay of the retained log, which an idempotent consumer absorbs
   * — rather than blocking the host from starting.
   */
  private async loadCursors(
    provider: SeatJournalConsumerProvider,
  ): Promise<Map<string, number>> {
    const cursors = new Map<string, number>();
    let stored: Record<string, string>;
    try {
      stored = await this.connections.base.hgetall(
        this.cursorKey(provider.provider),
      );
    } catch (err) {
      log.error(
        "seat.journal.consumer '%s': could not read its cursors and will replay from the start: %s",
        provider.provider,
        err,
      );
      return cursors;
    }
    for (const [member, value] of Object.entries(stored)) {
      const seq = Number(value);
      if (Number.isInteger(seq)) cursors.set(member, seq);
    }
    return cursors;
  }
}

/** The runtime's `subscribe`, which takes the `since` option the port omits. */
type RedisEventSubscribe = (
  handler: (event: CommittedActorEvent) => void | Promise<void>,
  options?: {since?: (actor: ActorId) => number | undefined},
) => () => void;
