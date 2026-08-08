// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  assertActorIdentityPart,
  type ActorDefinition,
  type ActorEventReader,
  type ActorId,
  type ActorInvokeOptions,
  type ActorRef,
  type ActorRuntime,
  type CommittedActorEvent,
} from '@agentback/actors';
import type {AnyActorDefinition} from './actor-durable-object.js';
import type {ActorDoNamespace, ActorDoStub} from './do-surface.js';
import {reviveActorError} from './protocol.js';

/**
 * The joined object name for one identity. `\u0000` cannot collide with a
 * caller-supplied part: `assertActorIdentityPart` rejects control characters
 * in both halves before any name is built.
 */
function objectName(actor: ActorId): string {
  return `${actor.type}\u0000${actor.id}`;
}

/**
 * Caller-side `ActorRuntime` adapter backed by a Durable Object namespace —
 * one object per actor identity, addressed by `idFromName`.
 *
 * Division of labor: identity validation, command parsing, and `requestId`
 * defaulting happen here (an invalid command is rejected before anything
 * crosses the wire); serialization, deadlines, rollback, dedup, and the
 * journal live in the object (`createActorDurableObject`), where the platform
 * guarantees a single instance per identity. Errors cross the boundary as
 * envelopes and are revived typed — a `TurnTimeoutError` arrives as a real
 * `TurnTimeoutError` naming the turn whose deadline actually fired.
 *
 * Implements `ActorEventReader` (so `ActorRegistry.events` works) but not
 * `ActorEventStore.subscribe`: a Durable Object has no portable push channel
 * to the caller, so live delivery is out of scope — read the log by identity
 * instead, or bind a runtime that delivers (`EventSourcedActorsComponent`,
 * `RedisActorsComponent`).
 */
export class DurableObjectActorRuntime
  implements ActorRuntime, ActorEventReader
{
  private readonly registered = new Map<string, AnyActorDefinition>();

  constructor(private readonly namespace: ActorDoNamespace) {}

  register<S, C, R>(definition: ActorDefinition<S, C, R>): void {
    const existing = this.registered.get(definition.name);
    if (existing && existing !== definition) {
      throw new Error(`Actor type '${definition.name}' is already registered.`);
    }
    this.registered.set(definition.name, definition);
  }

  /**
   * The definitions registered so far. The in-process host's Durable Object
   * class loads from here; a distributed deployment loads from the shared
   * module graph instead (see `createActorDurableObject`).
   */
  definitions(): readonly AnyActorDefinition[] {
    return [...this.registered.values()];
  }

  ref<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    id: string,
  ): ActorRef<C, R> {
    this.assertRegistered(definition);
    assertActorIdentityPart('id', id);
    const actor: ActorId = {type: definition.name, id};
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
    assertActorIdentityPart('id', id);
    const actor: ActorId = {type: definition.name, id};
    const outcome = await this.stub(actor).readState(actor);
    if (!outcome.ok) throw reviveActorError(outcome.error);
    return outcome.state as S;
  }

  async events(
    type: string,
    id: string,
  ): Promise<readonly CommittedActorEvent[]> {
    assertActorIdentityPart('type', type);
    assertActorIdentityPart('id', id);
    return this.stub({type, id}).readEvents();
  }

  private async invoke<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    actor: ActorId,
    command: C,
    options: ActorInvokeOptions = {},
  ): Promise<R> {
    const parsedCommand = definition.command.parse(command);
    const requestId = options.requestId ?? crypto.randomUUID();
    if (!requestId.trim())
      throw new Error('Actor requestId must not be empty.');
    // requestId becomes a storage key (`dedup:<requestId>`) and a member of
    // the FIFO order index inside the object, and Durable Object storage
    // caps both key size and single-value size — an unbounded id could brick
    // the identity's commits. 256 covers every real idempotency-key scheme.
    if (requestId.length > 256) {
      throw new Error(
        `Actor requestId must be at most 256 characters (got ${requestId.length}).`,
      );
    }

    const outcome = await this.stub(actor).turn({
      actor,
      requestId,
      command: parsedCommand,
    });
    if (!outcome.ok) throw reviveActorError(outcome.error);
    return outcome.result as R;
  }

  private stub(actor: ActorId): ActorDoStub {
    return this.namespace.get(this.namespace.idFromName(objectName(actor)));
  }

  private assertRegistered<S, C, R>(
    definition: ActorDefinition<S, C, R>,
  ): void {
    if (this.registered.get(definition.name) !== definition) {
      throw new Error(`Actor type '${definition.name}' is not registered.`);
    }
  }
}
