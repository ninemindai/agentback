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
  ): ActorRef<ActorServiceCommand, ActorServiceResult> {
    if (!this.started) throw new Error('Actor registry has not started.');
    return this.runtime.ref(this.definition(name), id);
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

    return defineActor(actorMeta.name, {
      state: actorMeta.state,
      command: z.object({name: z.string().min(1), input: z.unknown()}),
      result: z.object({name: z.string(), output: z.unknown()}),
      initialState: async id => {
        const instance = await this.resolve(bindingKey);
        return instance.initialState(id);
      },
      receive: async (ctx, state, command) => {
        const metadata = commands.get(command.name);
        if (!metadata) {
          throw new Error(
            `Unknown command '${command.name}' for actor '${actorMeta.name}'.`,
          );
        }
        const instance = await this.resolve(bindingKey);
        const input = metadata.input.parse(command.input);
        const method = (instance as unknown as Record<string, unknown>)[
          String(metadata.methodName)
        ] as ActorMethod;
        if (typeof method !== 'function') {
          throw new Error(
            `Actor '${actorMeta.name}' command '${metadata.name}' is not callable.`,
          );
        }
        const turn = await method.call(instance, state, input, ctx);
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
