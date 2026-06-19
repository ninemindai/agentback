// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

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
  type ActorClassMetadata,
  type ActorCommandMetadata,
} from './keys.js';
import type {
  Actor,
  ActorCommandContext,
  ActorDefinition,
  ActorInvokeOptions,
  ActorRef,
  ActorRuntime,
  ActorServiceCommand,
  ActorServiceResult,
  ActorTurn,
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

/**
 * Strongly-typed handle to one actor identity, derived from the actor class's
 * `@actorCommand` methods: each command method becomes
 * `(input, options?) => Promise<result>`. Returned by `registry.ref(ActorClass, id)`.
 *
 * Commands whose method declares no `input` parameter type as `unknown` input
 * (the proxy reads method signatures, not the Zod schema) — pass `{}` for them.
 */
export type ActorProxy<T> = {
  [K in keyof T as T[K] extends CommandShape ? K : never]: (
    input: CommandInput<T[K]>,
    options?: ActorInvokeOptions,
  ) => Promise<CommandResult<T[K]>>;
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
  private started = false;

  constructor(
    @extensions.view(ACTOR_EXTENSIONS)
    private readonly actorsView: ContextView<object>,
    @inject(ACTOR_RUNTIME) private readonly runtime: ActorRuntime,
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

    const ref = this.runtime.ref(definition, id);
    return new Proxy(Object.create(null) as ActorProxy<T>, {
      get: (_target, property) => {
        if (typeof property !== 'string') return undefined;
        const command = commandByMethod.get(property);
        if (!command) return undefined;
        return (input: unknown, options?: ActorInvokeOptions) =>
          ref.invoke({name: command, input}, options).then(turn => turn.output);
      },
    });
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
        return {
          state: turn.state,
          result: {name: metadata.name, output},
        };
      },
    });
  }

  private resolve(bindingKey: string): Promise<Actor<unknown>> {
    return this.actorsView.context.get<Actor<unknown>>(bindingKey);
  }
}
