// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ActorId, CommittedActorEvent} from '@agentback/actors';
import type {
  ActorDurableObjectClass,
  CreateActorDurableObjectOptions,
} from './actor-durable-object.js';
import {createActorDurableObject} from './actor-durable-object.js';
import {DurableObjectActorRuntime} from './do-actor-runtime.js';
import type {
  ActorDoNamespace,
  ActorDoStorage,
  ActorDoStub,
} from './do-surface.js';
import type {ReadStateOutcome, TurnOutcome, TurnRequest} from './protocol.js';

/**
 * In-memory `ActorDoStorage`. `put` applies every entry synchronously before
 * resolving — the atomic multi-key `put` the real storage documents — and
 * `get`/`list` return clones so a caller's mutation cannot reach the store.
 */
class InProcessDoStorage implements ActorDoStorage {
  private readonly entries = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const value = this.entries.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }

  async put(entries: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.entries.set(key, structuredClone(value));
    }
  }

  async list<T = unknown>(options: {prefix: string}): Promise<Map<string, T>> {
    const matched = [...this.entries.entries()]
      .filter(([key]) => key.startsWith(options.prefix))
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return new Map(
      matched.map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }
}

/**
 * A single-process Durable Object namespace: one lazily-created object
 * instance per `idFromName` name, each with its own private storage.
 *
 * Faithful where it matters for the turn contract, on purpose:
 *
 * - Calls cross the stub as **structured clones**, like real RPC — a mutation
 *   on either side of the boundary cannot leak through it.
 * - Calls are delivered **concurrently**, not queued: workerd interleaves
 *   in-flight requests at await points, so serialization must come from the
 *   object's own seat, and this host refuses to mask a bug there.
 *
 * This is also the single-process deployment story: wire it into
 * `installDurableObjectActors` and the same engine that runs on
 * Cloudflare/celld runs in memory (state lives for the process only).
 */
export class InProcessDurableObjectHost implements ActorDoNamespace {
  private readonly objects = new Map<string, ActorDoStub>();

  constructor(private readonly objectClass: ActorDurableObjectClass) {}

  idFromName(name: string): unknown {
    return {name};
  }

  get(id: unknown): ActorDoStub {
    const {name} = id as {name: string};
    let instance = this.objects.get(name);
    if (!instance) {
      instance = new this.objectClass({storage: new InProcessDoStorage()});
      this.objects.set(name, instance);
    }
    const target = instance;
    return {
      turn: (request: TurnRequest): Promise<TurnOutcome> =>
        target.turn(structuredClone(request)).then(structuredClone),
      readState: (actor: ActorId): Promise<ReadStateOutcome> =>
        target.readState(structuredClone(actor)).then(structuredClone),
      readEvents: (): Promise<CommittedActorEvent[]> =>
        target.readEvents().then(structuredClone),
    };
  }
}

/**
 * A ready-wired in-process Durable Objects actor runtime: the DO class loads
 * its definitions from the caller-side runtime's registrations (both sides
 * live in one process, so the shared-module-graph contract collapses to a
 * closure). The dev/test counterpart of handing
 * `DurableObjectActorRuntime` a real namespace binding.
 */
export function createInProcessDoActorRuntime(
  options: CreateActorDurableObjectOptions = {},
): DurableObjectActorRuntime {
  let runtime!: DurableObjectActorRuntime;
  const objectClass = createActorDurableObject(
    () => runtime.definitions(),
    options,
  );
  runtime = new DurableObjectActorRuntime(
    new InProcessDurableObjectHost(objectClass),
  );
  return runtime;
}
