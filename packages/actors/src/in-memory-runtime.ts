// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingScope, ContextTags, injectable} from '@agentback/core';
import {ACTOR_RUNTIME} from './keys.js';
import type {
  ActorDefinition,
  ActorId,
  ActorInvokeOptions,
  ActorRef,
  ActorRuntime,
} from './types.js';

interface StoredActor {
  state: unknown;
  results: Map<string, {commandFingerprint: string; result: unknown}>;
}

function actorKey(actor: ActorId): string {
  return `${actor.type}\u0000${actor.id}`;
}

/** Stable JSON fingerprint shared by ActorRuntime adapters. */
export function actorCommandFingerprint(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean'
    ) {
      return item;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new Error('Actor commands must contain only finite numbers.');
      }
      return item;
    }
    if (Array.isArray(item)) return item.map(canonicalize);
    if (typeof item === 'object') {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Actor commands must be JSON-serializable objects.');
      }
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    throw new Error('Actor commands must be JSON-serializable.');
  };
  return JSON.stringify(canonicalize(value));
}

export interface InMemoryActorRuntimeOptions {
  /**
   * Max committed request results retained per actor for idempotent replay.
   * The map is bounded FIFO: once full, the oldest entry is evicted, so
   * replaying a since-evicted requestId re-runs the command. Default 1024.
   */
  dedupLimit?: number;
}

/**
 * Single-process reference adapter for tests and design validation.
 *
 * The commit of state + request result is synchronous and occurs only after a
 * successful, schema-valid turn. This models the transaction a durable adapter
 * must provide, but does not make user side effects transactional.
 */
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: ACTOR_RUNTIME.key},
})
export class InMemoryActorRuntime implements ActorRuntime {
  private readonly definitions = new Map<string, object>();
  private readonly actors = new Map<string, StoredActor>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly dedupLimit: number;

  constructor(options: InMemoryActorRuntimeOptions = {}) {
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
    // Reads take no mailbox slot: commit reassigns `stored.state` atomically, so
    // a lone read observes either the pre- or post-commit value (never torn) and
    // runs concurrently with turns and other reads. An absent actor returns its
    // computed initial state without storing it (a read must not mutate).
    const stored = this.actors.get(actorKey({type: definition.name, id}));
    if (!stored) {
      return structuredClone(
        definition.state.parse(await definition.initialState(id)),
      ) as S;
    }
    return structuredClone(stored.state) as S;
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

      // The handler receives a clone. Mutation followed by throw cannot leak
      // into committed state, which is essential for retry-safe actor turns.
      const workingState = structuredClone(stored.state) as S;
      const turn = await definition.receive(
        {actor, requestId},
        workingState,
        parsedCommand,
      );
      const nextState = definition.state.parse(turn.state);
      const result = definition.result.parse(turn.result);

      // One in-memory commit point. A durable adapter must make these writes
      // atomic with acknowledgement of the command envelope.
      stored.state = structuredClone(nextState);
      stored.results.set(requestId, {
        commandFingerprint: fingerprint,
        result: structuredClone(result),
      });
      // Bound the dedup map. Map preserves insertion order, so the first key is
      // the oldest; the entry just added is newest and survives eviction.
      while (stored.results.size > this.dedupLimit) {
        const oldest = stored.results.keys().next().value as string;
        stored.results.delete(oldest);
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
