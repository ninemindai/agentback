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

const log = loggers('agentback:actors:redis:delivery');

export const SEAT_JOURNAL_CONSUMER_HOST_KEY = 'observers.SeatJournalConsumers';

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
 */
@lifeCycleObserver('20-seat-journal-consumers', {
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: SEAT_JOURNAL_CONSUMER_HOST_KEY},
})
export class SeatJournalConsumerHost implements LifeCycleObserver {
  private providers: SeatJournalConsumerProvider[] = [];
  private stale = true;
  private started = false;
  private unsubscribe?: () => void;

  constructor(
    @extensions.view(SEAT_JOURNAL_CONSUMER)
    private readonly consumers: ContextView<object>,
    @inject(ACTOR_RUNTIME) private readonly runtime: ActorRuntime,
  ) {
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
    this.unsubscribe = store.subscribe(event => this.deliver(event));
  }

  /**
   * Returned to the tail loop, which awaits it — so one slow consumer slows
   * only this loop, never the committing turn (delivery is entirely read
   * side), and per-identity order is preserved for everyone.
   */
  private async deliver(event: CommittedActorEvent): Promise<void> {
    if (this.stale) await this.refresh();
    await dispatchToExtensions(
      this.providers,
      SEAT_JOURNAL_CONSUMER,
      provider => provider.consume(event),
    );
  }

  private async refresh(): Promise<void> {
    this.stale = false;
    this.providers = await collectValidatedExtensions(
      this.consumers,
      SEAT_JOURNAL_CONSUMER,
      SeatJournalConsumerContract,
    );
  }
}
