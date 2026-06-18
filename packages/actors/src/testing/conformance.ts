// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {defineActor} from '../define-actor.js';
import type {ActorRuntime} from '../types.js';

const State = z.object({value: z.number()});
const Command = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('add'),
    amount: z.number(),
    waitMs: z.number().default(0),
  }),
  z.object({type: z.literal('fail')}),
]);
const Result = z.object({value: z.number()});

/** Behavioral contract required of every ActorRuntime adapter. */
export function runActorRuntimeConformance(
  name: string,
  makeRuntime: () => ActorRuntime,
): void {
  describe(`ActorRuntime conformance: ${name}`, () => {
    function counter(onTurn?: (id: string) => void) {
      return defineActor('conformance.counter', {
        state: State,
        command: Command,
        result: Result,
        initialState: () => ({value: 0}),
        async receive(ctx, state, command) {
          onTurn?.(ctx.actor.id);
          if (command.type === 'fail') {
            state.value = 999;
            throw new Error('turn failed');
          }
          if (command.waitMs) {
            await new Promise<void>(resolve =>
              setTimeout(resolve, command.waitMs),
            );
          }
          state.value += command.amount;
          return {state, result: {value: state.value}};
        },
      });
    }

    it('serializes turns for the same actor identity', async () => {
      const runtime = makeRuntime();
      const definition = counter();
      runtime.register(definition);
      const ref = runtime.ref(definition, 'one');

      const [first, second] = await Promise.all([
        ref.invoke({type: 'add', amount: 1, waitMs: 30}),
        ref.invoke({type: 'add', amount: 1, waitMs: 0}),
      ]);

      expect(first.value).toBe(1);
      expect(second.value).toBe(2);
      expect(await runtime.state(definition, 'one')).toEqual({value: 2});
    });

    it('allows different actor identities to run concurrently', async () => {
      const runtime = makeRuntime();
      let active = 0;
      let peak = 0;
      const definition = defineActor('conformance.parallel', {
        state: State,
        command: z.object({waitMs: z.number()}),
        result: Result,
        initialState: () => ({value: 0}),
        async receive(_ctx, state, command) {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>(resolve =>
            setTimeout(resolve, command.waitMs),
          );
          active--;
          return {state, result: state};
        },
      });
      runtime.register(definition);

      await Promise.all([
        runtime.ref(definition, 'a').invoke({waitMs: 20}),
        runtime.ref(definition, 'b').invoke({waitMs: 20}),
      ]);

      expect(peak).toBe(2);
    });

    it('rolls state back when a turn throws', async () => {
      const runtime = makeRuntime();
      const definition = counter();
      runtime.register(definition);
      const ref = runtime.ref(definition, 'rollback');

      await expect(ref.invoke({type: 'fail'})).rejects.toThrow('turn failed');
      expect(await runtime.state(definition, 'rollback')).toEqual({value: 0});
    });

    it('deduplicates a committed requestId', async () => {
      const runtime = makeRuntime();
      let turns = 0;
      const definition = counter(() => turns++);
      runtime.register(definition);
      const ref = runtime.ref(definition, 'dedup');

      const first = await ref.invoke(
        {type: 'add', amount: 3, waitMs: 0},
        {requestId: 'request-1'},
      );
      const replay = await ref.invoke(
        {type: 'add', amount: 3, waitMs: 0},
        {requestId: 'request-1'},
      );

      expect(first).toEqual({value: 3});
      expect(replay).toEqual(first);
      expect(turns).toBe(1);
      expect(await runtime.state(definition, 'dedup')).toEqual({value: 3});
    });

    it('rejects reuse of a requestId for a different command', async () => {
      const runtime = makeRuntime();
      const definition = counter();
      runtime.register(definition);
      const ref = runtime.ref(definition, 'collision');

      await ref.invoke(
        {type: 'add', amount: 1, waitMs: 0},
        {requestId: 'request-1'},
      );
      await expect(
        ref.invoke(
          {type: 'add', amount: 2, waitMs: 0},
          {requestId: 'request-1'},
        ),
      ).rejects.toThrow('different command');
      expect(await runtime.state(definition, 'collision')).toEqual({value: 1});
    });

    it('rolls state back when turn output fails validation', async () => {
      const runtime = makeRuntime();
      const definition = defineActor('conformance.invalid-output', {
        state: State,
        command: z.object({}),
        result: Result,
        initialState: () => ({value: 0}),
        receive(_ctx, state) {
          state.value = 10;
          return {state, result: {value: 'invalid'} as never};
        },
      });
      runtime.register(definition);
      const ref = runtime.ref(definition, 'invalid');

      await expect(ref.invoke({})).rejects.toThrow();
      expect(await runtime.state(definition, 'invalid')).toEqual({value: 0});
    });

    it('validates commands before delivery', async () => {
      const runtime = makeRuntime();
      let turns = 0;
      const definition = counter(() => turns++);
      runtime.register(definition);

      await expect(
        runtime
          .ref(definition, 'validation')
          .invoke({type: 'add', amount: 'bad'} as never),
      ).rejects.toThrow();
      expect(turns).toBe(0);
    });
  });
}
