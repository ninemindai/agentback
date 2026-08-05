// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  BindingScope,
  ContextTags,
  injectable,
  type Component,
} from '@agentback/core';
import {actorCommandFingerprint} from './in-memory-runtime.js';
import {ACTOR_RUNTIME} from './keys.js';
import {ActorRegistry} from './registry.js';
import type {
  ActorCommandContext,
  ActorDefinition,
  ActorEventStore,
  ActorId,
  ActorInvokeOptions,
  ActorRef,
  ActorRuntime,
  CommittedActorEvent,
} from './types.js';

interface StoredActor {
  state: unknown;
  seq: number;
  events: CommittedActorEvent[];
  results: Map<string, {commandFingerprint: string; result: unknown}>;
}

function actorKey(actor: ActorId): string {
  return `${actor.type}\u0000${actor.id}`;
}

export interface EventSourcedActorRuntimeOptions {
  /** Max committed request results retained per actor for replay. Default 1024. */
  dedupLimit?: number;
}

/**
 * Single-process reference adapter that keeps the authoritative state **and**
 * an append-only event log per identity. A command turn's `events` are
 * committed atomically with its state + dedup result, then delivered to
 * subscribers — so events are durable facts you can read back or react to,
 * without an event-sourced authoring model (state is still stored, not folded).
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: ACTOR_RUNTIME.key},
})
export class EventSourcedActorRuntime implements ActorRuntime, ActorEventStore {
  private readonly definitions = new Map<string, object>();
  private readonly actors = new Map<string, StoredActor>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly subscribers = new Set<(e: CommittedActorEvent) => void>();
  private readonly dedupLimit: number;

  constructor(options: EventSourcedActorRuntimeOptions = {}) {
    const limit = options.dedupLimit ?? 1024;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('dedupLimit must be a positive integer.');
    }
    this.dedupLimit = limit;
  }

  register<S, C, R>(definition: ActorDefinition<S, C, R>): void {
    const existing = this.definitions.get(definition.name);
    if (existing && existing !== definition) {
      throw new Error(`Actor type '${definition.name}' is already registered.`);
    }
    this.definitions.set(definition.name, definition);
  }

  ref<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    id: string,
  ): ActorRef<C, R> {
    this.assertRegistered(definition);
    if (!id.trim()) throw new Error('Actor id must not be empty.');
    const actor = {type: definition.name, id};
    return {
      actor,
      invoke: (command, options) =>
        this.invoke(definition, actor, command, options),
    };
  }

  async state<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    id: string,
  ): Promise<S> {
    this.assertRegistered(definition);
    if (!id.trim()) throw new Error('Actor id must not be empty.');
    // Lease-free read (see InMemoryActorRuntime): no mailbox slot.
    const stored = this.actors.get(actorKey({type: definition.name, id}));
    if (!stored) {
      return structuredClone(
        definition.state.parse(await definition.initialState(id)),
      ) as S;
    }
    return structuredClone(stored.state) as S;
  }

  async events(
    type: string,
    id: string,
  ): Promise<readonly CommittedActorEvent[]> {
    if (!id.trim()) throw new Error('Actor id must not be empty.');
    const stored = this.actors.get(actorKey({type, id}));
    return stored ? stored.events.map(event => structuredClone(event)) : [];
  }

  subscribe(handler: (event: CommittedActorEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  private async invoke<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    actor: ActorId,
    command: C,
    options: ActorInvokeOptions = {},
  ): Promise<R> {
    const parsedCommand = definition.command.parse(command);
    const fingerprint = actorCommandFingerprint(parsedCommand);
    const requestId = options.requestId ?? crypto.randomUUID();
    if (!requestId.trim())
      throw new Error('Actor requestId must not be empty.');

    return this.serialize(actorKey(actor), async () => {
      const stored = await this.load(definition, actor);
      const committed = stored.results.get(requestId);
      if (committed) {
        if (committed.commandFingerprint !== fingerprint) {
          throw new Error(
            `Actor requestId '${requestId}' was already used for a different command.`,
          );
        }
        return structuredClone(committed.result) as R;
      }

      const workingState = structuredClone(stored.state) as S;
      // Held onto (not inlined) so the seat key stamped onto it by `receive`
      // — see ActorCommandContext.seatKeyId — is still readable afterward.
      const ctx: ActorCommandContext = {actor, requestId};
      const turn = await definition.receive(ctx, workingState, parsedCommand);
      const nextState = definition.state.parse(turn.state);
      const result = definition.result.parse(turn.result);

      // One commit point: state, dedup result, and the event log all advance
      // together. A durable adapter must make these writes atomic.
      stored.state = structuredClone(nextState);
      stored.results.set(requestId, {
        commandFingerprint: fingerprint,
        result: structuredClone(result),
      });
      while (stored.results.size > this.dedupLimit) {
        const oldest = stored.results.keys().next().value as string;
        stored.results.delete(oldest);
      }
      const delivered: CommittedActorEvent[] = [];
      for (const event of turn.events ?? []) {
        const committedEvent: CommittedActorEvent = {
          actor,
          seq: stored.seq++,
          requestId,
          // No key row (no SeatKeyStore bound) commits the documented ''
          // sentinel — see ActorCommandContext.seatKeyId.
          seatKeyId: ctx.seatKeyId ?? '',
          event: structuredClone(event),
        };
        stored.events.push(committedEvent);
        delivered.push(committedEvent);
      }

      // Notify after the commit; a throwing subscriber must not fail the turn.
      for (const committedEvent of delivered) {
        for (const handler of this.subscribers) {
          try {
            handler(structuredClone(committedEvent));
          } catch {
            // a subscriber error is its own problem
          }
        }
      }
      return structuredClone(result);
    });
  }

  private assertRegistered<S, C, R>(
    definition: ActorDefinition<S, C, R>,
  ): void {
    if (this.definitions.get(definition.name) !== definition) {
      throw new Error(`Actor type '${definition.name}' is not registered.`);
    }
  }

  private async load<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    actor: ActorId,
  ): Promise<StoredActor> {
    const key = actorKey(actor);
    let stored = this.actors.get(key);
    if (!stored) {
      stored = {
        state: structuredClone(
          definition.state.parse(await definition.initialState(actor.id)),
        ),
        seq: 0,
        events: [],
        results: new Map(),
      };
      this.actors.set(key, stored);
    }
    return stored;
  }

  private async serialize<T>(
    key: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => {
      release = resolve;
    });
    this.tails.set(key, current);

    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}

/** Binds the actor runtime port to the event-logging reference adapter. */
export class EventSourcedActorsComponent implements Component {
  services = [EventSourcedActorRuntime, ActorRegistry];
}
