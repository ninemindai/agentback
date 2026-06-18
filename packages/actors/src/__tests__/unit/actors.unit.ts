// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Application, BindingScope} from '@agentback/core';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {InMemoryActorsComponent} from '../../component.js';
import {defineActor} from '../../define-actor.js';
import {ACTOR_RUNTIME} from '../../keys.js';
import {InMemoryActorRuntime} from '../../in-memory-runtime.js';

describe('@agentback/actors', () => {
  it('defines an actor descriptor with its schemas', () => {
    const state = z.object({count: z.number()});
    const command = z.object({amount: z.number()});
    const result = z.number();
    const actor = defineActor('counter', {
      state,
      command,
      result,
      initialState: () => ({count: 0}),
      receive: (_ctx, current, input) => ({
        state: {count: current.count + input.amount},
        result: current.count + input.amount,
      }),
    });

    expect(actor.name).toBe('counter');
    expect(actor.state).toBe(state);
    expect(actor.command).toBe(command);
    expect(actor.result).toBe(result);
    expect(actor.__kind).toBe('actor');
  });

  it('binds the injectable in-memory runtime as a singleton service', async () => {
    const app = new Application();
    app.component(InMemoryActorsComponent);
    const binding = app.getBinding(ACTOR_RUNTIME);
    expect(binding.scope).toBe(BindingScope.SINGLETON);
    expect(binding.valueConstructor).toBe(InMemoryActorRuntime);
    expect(await app.get(ACTOR_RUNTIME)).toBe(await app.get(ACTOR_RUNTIME));
  });
});
