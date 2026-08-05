// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

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
import {MetadataInspector} from '@agentback/metadata';
import {z} from 'zod';
import {defineActor} from './define-actor.js';
import {
  ACTOR_EXTENSIONS,
  ACTOR_REGISTRY,
  ACTOR_RUNTIME,
  ActorMetadata,
  SEAT_KEY_STORE,
  type ActorClassMetadata,
  type ActorCommandMetadata,
  type ActorQueryMetadata,
  type SeatKeyStore,
} from './keys.js';
import type {
  Actor,
  ActorCommandContext,
  ActorDefinition,
  ActorEventReader,
  ActorEventStore,
  ActorInvokeOptions,
  ActorQueryContext,
  ActorRef,
  ActorRuntime,
  ActorServiceCommand,
  ActorServiceResult,
  ActorTurn,
  CommittedActorEvent,
} from './types.js';

type ServiceActorDefinition = ActorDefinition<
  unknown,
  ActorServiceCommand,
  ActorServiceResult
>;

type ActorMethod = (
  state: unknown,
  input: unknown,
  ctx: ActorCommandContext,
) => ActorTurn<unknown, unknown> | Promise<ActorTurn<unknown, unknown>>;

type ActorQueryMethod = (
  state: unknown,
  input: unknown,
  ctx: ActorQueryContext,
) => unknown;

const log = loggers('agentback:actors:seatKeys');

/** A class decorated with `@actor` (carrying `@actorCommand` methods). */
export type ActorClass<T extends object> = abstract new (...args: never[]) => T;

type AnyActorTurn = ActorTurn<unknown, unknown>;
/** Matches any `@actorCommand` method by its `(state, input, ctx) => turn` shape. */
type CommandShape = (
  state: never,
  input: never,
  ctx: never,
) => AnyActorTurn | Promise<AnyActorTurn>;
type CommandInput<F> = F extends (
  state: never,
  input: infer I,
  ...rest: never[]
) => unknown
  ? I
  : never;
type CommandResult<F> = F extends (...args: never[]) => infer R
  ? Awaited<R> extends ActorTurn<unknown, infer O>
    ? O
    : never
  : never;

/** A `@actorQuery` method `(state, input, ctx) => result` (read-only, not a turn). */
type QueryShape = (state: never, ...rest: never[]) => unknown;
type QueryInput<F> = F extends (
  state: never,
  input: infer I,
  ...rest: never[]
) => unknown
  ? I
  : never;
type QueryResult<F> = F extends (...args: never[]) => infer R
  ? Awaited<R>
  : never;

/**
 * Strongly-typed handle to one actor identity, derived from the actor class's
 * `@actorCommand` and `@actorQuery` methods. Each command becomes
 * `(input, options?) => Promise<result>`; each query becomes
 * `(input) => Promise<result>`. Returned by `registry.ref(ActorClass, id)`.
 *
 * A method that declares no `input` parameter types its input as `unknown` (the
 * proxy reads method signatures, not the Zod schema) — pass `{}` for those.
 */
export type ActorProxy<T> = {
  [K in keyof T as T[K] extends CommandShape ? K : never]: (
    input: CommandInput<T[K]>,
    options?: ActorInvokeOptions,
  ) => Promise<CommandResult<T[K]>>;
} & {
  [
    K in keyof Omit<T, 'initialState'> as T[K] extends CommandShape
      ? never
      : T[K] extends QueryShape
        ? K
        : never
  ]: (input: QueryInput<T[K]>) => Promise<QueryResult<T[K]>>;
};

/**
 * Discovers `@actor` service extensions at startup and compiles their decorated
 * methods into the runtime's transport-neutral ActorDefinition contract.
 */
@lifeCycleObserver('10-actor-registry', {
  scope: BindingScope.SINGLETON,
  tags: {[ContextTags.KEY]: ACTOR_REGISTRY.key},
})
export class ActorRegistry implements LifeCycleObserver {
  private readonly definitions = new Map<string, ServiceActorDefinition>();
  /** Per-actor query metadata + binding key, for the lease-free query path. */
  private readonly queryActors = new Map<
    string,
    {bindingKey: string; queries: Map<string, ActorQueryMetadata>}
  >();
  private started = false;

  constructor(
    @extensions.view(ACTOR_EXTENSIONS)
    private readonly actorsView: ContextView<object>,
    @inject(ACTOR_RUNTIME) private readonly runtime: ActorRuntime,
    // Optional: apps without the seat layer configured keep working — no key
    // row is ever created, and nothing signs regardless (capability-os#5).
    @inject(SEAT_KEY_STORE, {optional: true})
    private readonly seatKeyStore?: SeatKeyStore,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    for (const binding of this.actorsView.bindings) {
      const ctor = binding.valueConstructor;
      if (typeof ctor !== 'function') continue;
      const definition = this.compile(binding.key, ctor);
      if (this.definitions.has(definition.name)) {
        throw new Error(`Duplicate actor type '${definition.name}'.`);
      }
      this.runtime.register(definition);
      this.definitions.set(definition.name, definition);
    }
    this.started = true;
  }

  list(): string[] {
    return [...this.definitions.keys()];
  }

  definition(name: string): ServiceActorDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`Unknown actor type '${name}'.`);
    return definition;
  }

  ref(
    name: string,
    id: string,
  ): ActorRef<ActorServiceCommand, ActorServiceResult>;
  ref<T extends object>(actor: ActorClass<T>, id: string): ActorProxy<T>;
  ref(
    actor: string | ActorClass<object>,
    id: string,
  ): ActorRef<ActorServiceCommand, ActorServiceResult> | ActorProxy<object> {
    if (!this.started) throw new Error('Actor registry has not started.');
    if (typeof actor === 'function') return this.makeProxy(actor, id);
    return this.runtime.ref(this.definition(actor), id);
  }

  state(name: string, id: string): Promise<unknown> {
    if (!this.started) throw new Error('Actor registry has not started.');
    return this.runtime.state(this.definition(name), id);
  }

  /** The committed event log for one identity (requires an event-log runtime). */
  events(name: string, id: string): Promise<readonly CommittedActorEvent[]> {
    if (!this.started) throw new Error('Actor registry has not started.');
    this.definition(name); // validate the actor type exists
    return this.eventReader().events(name, id);
  }

  /** Observe every committed event (requires an event-log runtime). */
  subscribe(handler: (event: CommittedActorEvent) => void): () => void {
    if (!this.started) throw new Error('Actor registry has not started.');
    return this.eventStore().subscribe(handler);
  }

  /** Reading a durable log needs no delivery half (see `ActorEventReader`). */
  private eventReader(): ActorEventReader {
    const runtime = this.runtime as Partial<ActorEventStore>;
    if (typeof runtime.events !== 'function') {
      throw new Error(
        'The bound ActorRuntime does not persist events. Use EventSourcedActorsComponent (in-memory) or RedisActorsComponent (durable).',
      );
    }
    return runtime as ActorEventReader;
  }

  private eventStore(): ActorEventStore {
    const runtime = this.runtime as Partial<ActorEventStore>;
    if (typeof runtime.subscribe !== 'function') {
      throw new Error(
        'The bound ActorRuntime persists events but does not deliver them. Use EventSourcedActorsComponent (in-memory) or RedisActorsComponent (durable), or read the log with events().',
      );
    }
    return this.eventReader() as ActorEventStore;
  }

  invoke(
    name: string,
    id: string,
    command: ActorServiceCommand,
    options?: ActorInvokeOptions,
  ): Promise<ActorServiceResult> {
    return this.ref(name, id).invoke(command, options);
  }

  /**
   * Build a typed proxy over one identity. Reads the actor name and the
   * methodName→commandName map from `@actor`/`@actorCommand` metadata, then maps
   * each property access to `runtime.ref(...).invoke({name, input}, options)`.
   */
  private makeProxy<T extends object>(
    ctor: ActorClass<T>,
    id: string,
  ): ActorProxy<T> {
    const fn = ctor as Function;
    const actorMeta = MetadataInspector.getClassMetadata<ActorClassMetadata>(
      ActorMetadata.CLASS,
      fn,
    );
    if (!actorMeta) {
      throw new Error(`Class '${fn.name}' is not an @actor.`);
    }
    const definition = this.definition(actorMeta.name); // throws if unregistered
    const commandByMethod = new Map<string, string>();
    const methods =
      MetadataInspector.getAllMethodMetadata<ActorCommandMetadata>(
        ActorMetadata.COMMAND,
        fn.prototype,
      ) ?? {};
    for (const [methodName, metadata] of Object.entries(methods)) {
      if (metadata) commandByMethod.set(methodName, metadata.name);
    }
    const queryByMethod = new Map<string, string>();
    const queryMethods =
      MetadataInspector.getAllMethodMetadata<ActorQueryMetadata>(
        ActorMetadata.QUERY,
        fn.prototype,
      ) ?? {};
    for (const [methodName, metadata] of Object.entries(queryMethods)) {
      if (metadata) queryByMethod.set(methodName, metadata.name);
    }

    const actorName = actorMeta.name;
    const ref = this.runtime.ref(definition, id);
    return new Proxy(Object.create(null) as ActorProxy<T>, {
      get: (_target, property) => {
        if (typeof property !== 'string') return undefined;
        const command = commandByMethod.get(property);
        if (command) {
          return (input: unknown, options?: ActorInvokeOptions) =>
            ref
              .invoke({name: command, input}, options)
              .then(turn => turn.output);
        }
        const query = queryByMethod.get(property);
        if (query) {
          return (input: unknown) => this.runQuery(actorName, query, id, input);
        }
        return undefined;
      },
    });
  }

  query(
    name: string,
    id: string,
    query: ActorServiceCommand,
  ): Promise<unknown> {
    if (!this.started) throw new Error('Actor registry has not started.');
    return this.runQuery(name, query.name, id, query.input);
  }

  /**
   * Run one read-only query. Reads a state snapshot through the runtime's
   * lease-free `state()` (no mailbox, no lease — concurrent with turns), then
   * applies the DI-resolved query method and validates its output.
   */
  private async runQuery(
    actorName: string,
    queryName: string,
    id: string,
    input: unknown,
  ): Promise<unknown> {
    const entry = this.queryActors.get(actorName);
    const metadata = entry?.queries.get(queryName);
    if (!entry || !metadata) {
      throw new Error(`Unknown query '${queryName}' for actor '${actorName}'.`);
    }
    if (!id.trim()) throw new Error('Actor id must not be empty.');
    const parsedInput = metadata.input.parse(input);
    const state = await this.runtime.state(this.definition(actorName), id);
    const instance = await this.resolve(entry.bindingKey);
    const method = (instance as unknown as Record<string, unknown>)[
      String(metadata.methodName)
    ] as ActorQueryMethod;
    if (typeof method !== 'function') {
      throw new Error(
        `Actor '${actorName}' query '${queryName}' is not callable.`,
      );
    }
    const result = await method.call(instance, state, parsedInput, {
      actor: {type: actorName, id},
    });
    return metadata.output.parse(result);
  }

  private compile(bindingKey: string, ctor: Function): ServiceActorDefinition {
    const actorMeta = MetadataInspector.getClassMetadata<ActorClassMetadata>(
      ActorMetadata.CLASS,
      ctor,
    );
    if (!actorMeta) {
      throw new Error(
        `Actor binding '${bindingKey}' is missing @actor metadata.`,
      );
    }
    const all =
      MetadataInspector.getAllMethodMetadata<ActorCommandMetadata>(
        ActorMetadata.COMMAND,
        ctor.prototype,
      ) ?? {};
    const commands = new Map<string, ActorCommandMetadata>();
    for (const [methodName, metadata] of Object.entries(all)) {
      if (!metadata) continue;
      if (commands.has(metadata.name)) {
        throw new Error(
          `Actor '${actorMeta.name}' has duplicate command '${metadata.name}'.`,
        );
      }
      commands.set(metadata.name, {...metadata, methodName});
    }
    if (!commands.size) {
      throw new Error(
        `Actor '${actorMeta.name}' has no @actorCommand methods.`,
      );
    }

    // Collect read-only @actorQuery methods (run lease-free; never registered
    // with the runtime, which only knows about state + commands).
    const queries = new Map<string, ActorQueryMetadata>();
    const queryMeta =
      MetadataInspector.getAllMethodMetadata<ActorQueryMetadata>(
        ActorMetadata.QUERY,
        ctor.prototype,
      ) ?? {};
    for (const [methodName, metadata] of Object.entries(queryMeta)) {
      if (!metadata) continue;
      if (all[methodName]) {
        throw new Error(
          `Actor '${actorMeta.name}' method '${methodName}' is both a command and a query.`,
        );
      }
      if (queries.has(metadata.name)) {
        throw new Error(
          `Actor '${actorMeta.name}' has duplicate query '${metadata.name}'.`,
        );
      }
      queries.set(metadata.name, {...metadata, methodName});
    }
    this.queryActors.set(actorMeta.name, {bindingKey, queries});

    // Validate and normalize each command's input at the envelope boundary so
    // the runtime computes its fingerprint (and request dedup) over parsed,
    // default-applied values rather than the raw payload.
    const command = z
      .object({name: z.string().min(1), input: z.unknown()})
      .transform((envelope, ctx): ActorServiceCommand => {
        const metadata = commands.get(envelope.name);
        if (!metadata) {
          ctx.addIssue({
            code: 'custom',
            message: `Unknown command '${envelope.name}' for actor '${actorMeta.name}'.`,
          });
          return z.NEVER;
        }
        const parsed = metadata.input.safeParse(envelope.input);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            ctx.addIssue({
              code: 'custom',
              path: ['input', ...issue.path],
              message: issue.message,
            });
          }
          return z.NEVER;
        }
        return {name: envelope.name, input: parsed.data};
      });

    return defineActor(actorMeta.name, {
      state: actorMeta.state,
      // The seat class / deadline the class declared on `@actor`, resolved by
      // `defineActor` exactly as a raw `defineActor` caller's would be.
      seatClass: actorMeta.seatClass,
      deadlineMs: actorMeta.deadlineMs,
      command,
      result: z.object({name: z.string(), output: z.unknown()}),
      initialState: async id => {
        const instance = await this.resolve(bindingKey);
        return instance.initialState(id);
      },
      receive: async (ctx, state, command) => {
        const metadata = commands.get(command.name);
        if (!metadata) {
          // Unreachable via `command` parsing above; kept for adapters that call
          // `receive` with an already-validated envelope.
          throw new Error(
            `Unknown command '${command.name}' for actor '${actorMeta.name}'.`,
          );
        }
        // Custodial keypair at birth, dormant (capability-os#5): a key row is
        // ensured when an identity first COMMITS a turn, not when it is
        // merely addressed. `receive` only runs for a schema-validated
        // command that reached the mailbox and is not a dedup replay (every
        // runtime short-circuits both before calling `receive`) — never for
        // a lease-free read/query, which deliberately never persists (see
        // in-memory-runtime.ts: "a read must not mutate"). Unauthenticated
        // enumeration of read-only routes therefore cannot force keygen.
        // Idempotent via the store's own `create()`. If the store is bound
        // but its `create()` throws, this turn fails closed (no state
        // commits) rather than silently skipping key creation — a broken
        // seat key store must not let seats materialize without one.
        const seatKeyId = await this.ensureSeatKey(
          actorMeta.name,
          ctx.actor.id,
        );
        const instance = await this.resolve(bindingKey);
        const method = (instance as unknown as Record<string, unknown>)[
          String(metadata.methodName)
        ] as ActorMethod;
        if (typeof method !== 'function') {
          throw new Error(
            `Actor '${actorMeta.name}' command '${metadata.name}' is not callable.`,
          );
        }
        const turn = await method.call(instance, state, command.input, ctx);
        const output = metadata.output.parse(turn.result);
        // The acting seat, journaled with this turn's events. Set on ctx —
        // not returned on the turn — and only *after* the command method has
        // returned, so nothing it did to `ctx.seatKeyId` during the call can
        // survive: whatever it mutated is overwritten here. A runtime reads
        // this back off `ctx` once `receive` resolves (see
        // ActorCommandContext.seatKeyId).
        ctx.seatKeyId = seatKeyId;
        return {
          state: turn.state,
          result: {name: metadata.name, output},
          events: turn.events, // passed through to an event-log runtime
        };
      },
    });
  }

  private resolve(bindingKey: string): Promise<Actor<unknown>> {
    return this.actorsView.context.get<Actor<unknown>>(bindingKey);
  }

  /**
   * Returns the acting seat's key id, or `undefined` when no SeatKeyStore is
   * bound (the deliberate degrade: the app keeps working, keyless).
   * `create()` itself is idempotent.
   */
  private async ensureSeatKey(
    type: string,
    id: string,
  ): Promise<string | undefined> {
    if (!this.seatKeyStore) return undefined;
    const record = await this.seatKeyStore.create({type, id});
    if (log.debug.enabled) {
      log.debug(
        'Seat key %s ready for actor %s/%s.',
        record.seatKeyId,
        type,
        id,
      );
    }
    return record.seatKeyId;
  }
}
