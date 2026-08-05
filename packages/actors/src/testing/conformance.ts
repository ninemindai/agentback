// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {createECDH, randomBytes} from 'node:crypto';
import {Application} from '@agentback/core';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {ACTOR_TURN_TIMEOUT_EVENT, TurnTimeoutError} from '../deadlines.js';
import {actor, actorCommand} from '../decorators.js';
import {defineActor} from '../define-actor.js';
import {InMemorySeatKeyStore} from '../in-memory-seat-key-store.js';
import {
  ACTOR_REGISTRY,
  ACTOR_RUNTIME,
  SEAT_KEY_STORE,
  SEAT_KEY_STORE_KEK,
  type SeatKeyStore,
} from '../keys.js';
import {ActorRegistry} from '../registry.js';
import type {
  Actor,
  ActorEventReader,
  ActorId,
  ActorRuntime,
  ActorTurn,
} from '../types.js';

/**
 * A minimal `@actor` used only to exercise the registry-driven path (its
 * `ensureSeatKey` + `receive` wiring) against a journaling runtime — as
 * opposed to the raw `defineActor` cases above, which set `seatKeyId`
 * themselves and so never prove the registry actually plumbs the store's key
 * row onto the turn.
 */
const SeatedJournalState = z.object({});
type SeatedJournalStateT = z.infer<typeof SeatedJournalState>;

@actor('conformance.journal.seated', {state: SeatedJournalState})
class SeatedJournalActor implements Actor<SeatedJournalStateT> {
  initialState(): SeatedJournalStateT {
    return {};
  }

  @actorCommand('go', {input: z.object({}), output: z.object({})})
  go(
    state: SeatedJournalStateT,
  ): ActorTurn<SeatedJournalStateT, SeatedJournalStateT> {
    return {state, result: {}, events: [{type: 'Seated'}]};
  }
}

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

/**
 * An outer actor whose turn invokes an inner actor that hangs — the shape an
 * `@injectActor` call takes at the runtime layer. Two identities, one seat
 * each, with the *inner* one's deadline firing inside the outer one's turn.
 * The outer deadline is long enough that it can never be the one that fires.
 */
function nested(runtime: ActorRuntime) {
  const inner = defineActor('conformance.deadline.inner', {
    state: State,
    command: z.object({}),
    result: Result,
    deadlineMs: 50,
    initialState: () => ({value: 0}),
    async receive() {
      await new Promise<never>(() => {});
      throw new Error('unreachable');
    },
  });
  const outer = defineActor('conformance.deadline.outer', {
    state: State,
    command: z.object({}),
    result: Result,
    deadlineMs: 5_000,
    initialState: () => ({value: 0}),
    async receive(_ctx, state) {
      state.value = 99; // must roll back with the rest of the turn
      await runtime.ref(inner, 'hangs').invoke({}, {requestId: 'nested'});
      return {state, result: state};
    },
  });
  runtime.register(inner);
  runtime.register(outer);
  return {runtime, inner, outer};
}

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

    it('serializes concurrent turns for one identity (mutual exclusion)', async () => {
      const runtime = makeRuntime();
      const definition = counter();
      runtime.register(definition);
      const ref = runtime.ref(definition, 'one');

      // Two overlapping turns. Mutual exclusion means each reads the other's
      // committed state, so the two results are {1} and {2} and the final state
      // is 2. Submission order is NOT part of the port contract — a distributed
      // adapter resolves the lock by a race, not a FIFO queue — so we assert the
      // set of results, not which call returned which. (The in-memory adapter's
      // stronger FIFO guarantee is covered in its own unit test.)
      const results = await Promise.all([
        ref.invoke({type: 'add', amount: 1, waitMs: 30}),
        ref.invoke({type: 'add', amount: 1, waitMs: 0}),
      ]);

      expect(results.map(turn => turn.value).sort((a, b) => a - b)).toEqual([
        1, 2,
      ]);
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

    // -- Per-seat-type deadlines (capability-os#7) ------------------------
    //
    // A timeout is a recorded failed turn, never a wedge. These cases pin the
    // caller-visible half on every adapter (typed error, free seat, nothing
    // committed, retryable requestId); the journaled half is in
    // `runActorEventStoreConformance`, and the log-only record that stands in
    // for it on the journal-free runtime is in `in-memory-runtime.unit.ts`.
    //
    // Deadlines here are tiny on purpose — the shipped defaults are 30s and
    // 10min, and no suite should wait for either.
    function hanging(hangs: () => boolean) {
      return defineActor('conformance.deadline', {
        state: State,
        command: z.object({amount: z.number()}),
        result: Result,
        deadlineMs: 50,
        initialState: () => ({value: 0}),
        async receive(_ctx, state, command) {
          // Abandoned, not cancelled: nothing ever settles this.
          if (hangs()) await new Promise<never>(() => {});
          state.value += command.amount;
          return {state, result: {value: state.value}};
        },
      });
    }

    /**
     * A `receive` that overruns its deadline **synchronously**. The spin is
     * short (80ms against a 50ms deadline) but it blocks the event loop
     * outright, so no timer — the deadline's, or Redis's lease renewal — can
     * fire while it runs.
     */
    function spinning(spins: () => boolean) {
      return defineActor('conformance.deadline.sync', {
        state: State,
        command: z.object({amount: z.number()}),
        result: Result,
        deadlineMs: 50,
        initialState: () => ({value: 0}),
        receive(_ctx, state, command) {
          if (spins()) {
            const until = Date.now() + 80;
            while (Date.now() < until) {
              /* deliberately blocking */
            }
          }
          state.value += command.amount;
          return {state, result: {value: state.value}};
        },
      });
    }

    it('fails a turn that outlives its deadline, committing nothing', async () => {
      const runtime = makeRuntime();
      const definition = hanging(() => true);
      runtime.register(definition);
      const ref = runtime.ref(definition, 'wedged');

      await expect(
        ref.invoke({amount: 1}, {requestId: 'hangs'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);
      expect(await runtime.state(definition, 'wedged')).toEqual({value: 0});
    });

    it('frees the seat immediately after a deadline, for the next turn', async () => {
      const runtime = makeRuntime();
      let hangs = true;
      const definition = hanging(() => hangs);
      runtime.register(definition);
      const ref = runtime.ref(definition, 'freed');

      await expect(
        ref.invoke({amount: 1}, {requestId: 'hangs'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);

      // The next turn must not queue behind the abandoned one, which never
      // settles: it runs now, off the state the timed-out turn did not move.
      hangs = false;
      const started = Date.now();
      expect(await ref.invoke({amount: 2}, {requestId: 'next'})).toEqual({
        value: 2,
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await runtime.state(definition, 'freed')).toEqual({value: 2});
    });

    it('lets a timed-out requestId run on retry (a timeout is not a cached result)', async () => {
      const runtime = makeRuntime();
      let hangs = true;
      const definition = hanging(() => hangs);
      runtime.register(definition);
      const ref = runtime.ref(definition, 'retried');

      await expect(
        ref.invoke({amount: 3}, {requestId: 'once'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);

      // The failed turn wrote no dedup record — it touched neither state nor
      // dedup — so the same requestId is free to run rather than replaying a
      // "failure result" it never committed.
      hangs = false;
      expect(await ref.invoke({amount: 3}, {requestId: 'once'})).toEqual({
        value: 3,
      });
      expect(await runtime.state(definition, 'retried')).toEqual({value: 3});
    });

    it('never lets an abandoned turn commit over the turn that replaced it', async () => {
      // The moat case. A turn that merely runs *late* — not forever — resolves
      // after its seat has already been handed to someone else. Committing it
      // then would silently overwrite the newer state off a stale read, so the
      // abandoned turn must be refused at the commit, not merely un-awaited.
      // Each adapter refuses it with the same guard it uses for everything
      // else: the lease token on Redis, its in-process counterpart otherwise.
      const runtime = makeRuntime();
      const definition = defineActor('conformance.deadline.late', {
        state: State,
        command: z.object({amount: z.number(), waitMs: z.number()}),
        result: Result,
        deadlineMs: 50,
        initialState: () => ({value: 0}),
        async receive(_ctx, state, command) {
          if (command.waitMs) {
            await new Promise<void>(resolve =>
              setTimeout(resolve, command.waitMs),
            );
          }
          state.value += command.amount;
          return {state, result: {value: state.value}};
        },
      });
      runtime.register(definition);
      const ref = runtime.ref(definition, 'late');

      await expect(
        ref.invoke({amount: 100, waitMs: 400}, {requestId: 'late'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);
      expect(
        await ref.invoke({amount: 7, waitMs: 0}, {requestId: 'next'}),
      ).toEqual({value: 7});

      // Well past the abandoned turn's own completion.
      await new Promise<void>(resolve => setTimeout(resolve, 500));
      expect(await runtime.state(definition, 'late')).toEqual({value: 7});
    });

    it('fails a turn whose cold-start state load outlives its deadline', async () => {
      // The deadline covers the **whole** turn, and a cold identity's
      // `initialState` is part of it. Redis used to race `receive` alone, so a
      // hanging `initialState` produced no `TurnTimeoutError`, no marker, and
      // an `invoke()` promise that never settled — the one shape of wedge the
      // deadline exists to rule out, reachable through the one phase it did
      // not cover.
      const runtime = makeRuntime();
      let slowInit = true;
      let turns = 0;
      const definition = defineActor('conformance.deadline.slow-init', {
        state: State,
        command: z.object({amount: z.number()}),
        result: Result,
        deadlineMs: 50,
        initialState: async () => {
          // Abandoned, not cancelled: nothing ever settles this.
          if (slowInit) await new Promise<never>(() => {});
          return {value: 0};
        },
        receive(_ctx, state, command) {
          turns++;
          state.value += command.amount;
          return {state, result: {value: state.value}};
        },
      });
      runtime.register(definition);
      const ref = runtime.ref(definition, 'cold-hang');

      await expect(
        ref.invoke({amount: 1}, {requestId: 'hangs'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);
      // The turn never reached `receive`, so nothing could have committed.
      expect(turns).toBe(0);

      // And the seat is free: the next turn runs at once, off a fast load.
      slowInit = false;
      const started = Date.now();
      expect(await ref.invoke({amount: 2}, {requestId: 'next'})).toEqual({
        value: 2,
      });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(await runtime.state(definition, 'cold-hang')).toEqual({value: 2});
    });

    it('never lets a late initialState reset an identity that has committed', async () => {
      // Freeing the seat at the deadline means a turn is no longer alone on
      // its identity for as long as it runs, which is exactly the assumption
      // a check-then-await-then-store `load` rested on. A first turn whose
      // `initialState` outlives the deadline resolves *after* a second turn
      // has committed; publishing its fresh record then would reset state and
      // drop the dedup map.
      const runtime = makeRuntime();
      let turns = 0;
      let slowInit = true;
      const definition = defineActor('conformance.deadline.cold-init', {
        state: State,
        command: z.object({amount: z.number()}),
        result: Result,
        deadlineMs: 50,
        initialState: async () => {
          // Only the first touch is slow — the turn that replaces it must be
          // able to initialize the identity promptly.
          if (slowInit) {
            slowInit = false;
            await new Promise<void>(resolve => setTimeout(resolve, 300));
          }
          return {value: 0};
        },
        receive(_ctx, state, command) {
          turns++;
          state.value += command.amount;
          return {state, result: {value: state.value}};
        },
      });
      runtime.register(definition);
      const ref = runtime.ref(definition, 'cold');

      // Every runtime races the state load, so this turn is abandoned mid-load
      // and its `initialState` keeps running. What the abandoned continuation
      // does next differs — the in-process runtimes go on to `receive`, Redis
      // discards the load's value at the settled race — and the invariant
      // asserted below holds either way.
      await ref
        .invoke({amount: 1}, {requestId: 'first'})
        .catch(() => undefined);

      const anchor = await ref.invoke({amount: 5}, {requestId: 'anchor'});

      // Past the slow initialState's own resolution. On the in-process
      // runtimes the abandoned turn resumes in this window: it picks up the
      // record the anchor turn committed, runs its `receive` — which is why
      // the turn counter may grow here — and is then refused at the commit by
      // its expired guard.
      await new Promise<void>(resolve => setTimeout(resolve, 400));

      // Committed state survives all of that.
      expect(await runtime.state(definition, 'cold')).toEqual(anchor);

      // And so does the dedup record: replaying the anchor returns the
      // committed result without running the command again. (A reset identity
      // would have lost the record and re-run it, moving state past `anchor`.)
      const turnsBeforeReplay = turns;
      expect(await ref.invoke({amount: 5}, {requestId: 'anchor'})).toEqual(
        anchor,
      );
      expect(turns).toBe(turnsBeforeReplay);
      expect(await runtime.state(definition, 'cold')).toEqual(anchor);
    });

    it('attributes a nested timeout to the inner turn, not the caller', async () => {
      // An actor turn may invoke another actor (`@injectActor` is a
      // first-class shape), so an inner `TurnTimeoutError` propagates out
      // through the outer turn's `receive`. To the outer turn that is an
      // ordinary thrown turn — it rolls back — and the error must keep naming
      // the identity whose deadline actually fired, or a runtime classifying
      // by error type alone would record the incident twice.
      const {runtime, outer} = nested(makeRuntime());

      const error = await runtime
        .ref(outer, 'caller')
        .invoke({}, {requestId: 'outer-call'})
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(TurnTimeoutError);
      const timeout = error as TurnTimeoutError;
      expect(timeout.actor).toEqual({
        type: 'conformance.deadline.inner',
        id: 'hangs',
      });
      expect(timeout.requestId).toBe('nested');
      expect(timeout.deadlineMs).toBe(50);

      // The outer turn rolled back like any other failed turn, and its seat is
      // free — it was never itself late.
      expect(await runtime.state(outer, 'caller')).toEqual({value: 0});
    });

    it('fails a turn that blows its deadline synchronously, committing nothing', async () => {
      // A busy `receive` is the case a timer cannot see: nothing preempts
      // synchronous CPU work, and the continuation that follows it runs as a
      // microtask, ahead of the expired timer's callback. Without an
      // elapsed-time re-check at the commit boundary this turn commits
      // normally (and on Redis it fails as a *lost lease* instead, with no
      // timeout recorded anywhere).
      const runtime = makeRuntime();
      let spins = true;
      const definition = spinning(() => spins);
      runtime.register(definition);
      const ref = runtime.ref(definition, 'sync-overrun');

      await expect(
        ref.invoke({amount: 1}, {requestId: 'spin'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);
      expect(await runtime.state(definition, 'sync-overrun')).toEqual({
        value: 0,
      });

      // And the seat is free, exactly as after an async timeout.
      spins = false;
      expect(await ref.invoke({amount: 2}, {requestId: 'next'})).toEqual({
        value: 2,
      });
    });

    it('rejects an actor id carrying a control character', async () => {
      // The in-process runtimes and the Redis journal subscriber key a seat on
      // `type + U+0000 + id`, so an unchecked control character in a
      // caller-supplied id aliases two identities onto one seat. Rejected at
      // the shared validation choke point, on every runtime at once.
      const runtime = makeRuntime();
      const definition = counter();
      runtime.register(definition);

      expect(() => runtime.ref(definition, 'a\u0000b')).toThrow(
        /control characters/,
      );
      await expect(runtime.state(definition, 'a\u0000b')).rejects.toThrow(
        /control characters/,
      );
      expect(() => runtime.ref(definition, 'a\u001Fb')).toThrow(
        /control characters/,
      );

      // An ordinary id is untouched, punctuation and all.
      expect(
        await runtime.ref(definition, 'ada:lovelace-1').invoke({
          type: 'add',
          amount: 1,
          waitMs: 0,
        }),
      ).toEqual({value: 1});
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

/**
 * Behavioral contract required of every runtime that persists an append-only
 * event log per identity (the read/append half of `ActorEventStore`). Every
 * case here is an atomicity claim: a turn's events reach the log exactly when
 * that turn's state and dedup record do — never on a rollback, never twice on
 * a replay. Delivery (`subscribe`) is not covered; a runtime that only reads
 * back its log satisfies this suite.
 */
export function runActorEventStoreConformance(
  name: string,
  makeRuntime: () => ActorRuntime & ActorEventReader,
): void {
  describe(`ActorEventStore conformance: ${name}`, () => {
    const JournalState = z.object({count: z.number()});
    const JournalCommand = z.discriminatedUnion('type', [
      z.object({type: z.literal('inc'), by: z.number()}),
      z.object({type: z.literal('quiet')}),
      z.object({type: z.literal('boom')}),
    ]);

    const TYPE = 'conformance.journal';

    function journal() {
      return defineActor(TYPE, {
        state: JournalState,
        command: JournalCommand,
        result: JournalState,
        initialState: () => ({count: 0}),
        receive(_ctx, state, command) {
          if (command.type === 'boom') {
            state.count = 999;
            throw new Error('turn failed');
          }
          // `quiet` still commits state + dedup, but emits no event: the log
          // is per event, not per turn.
          if (command.type === 'quiet') {
            state.count += 1;
            return {state, result: state};
          }
          state.count += command.by;
          return {
            state,
            result: state,
            events: [{type: 'Incremented', by: command.by}],
          };
        },
      });
    }

    it('appends a turn events to the identity log, in order', async () => {
      const runtime = makeRuntime();
      const definition = journal();
      runtime.register(definition);
      const ref = runtime.ref(definition, 'a');

      await ref.invoke({type: 'inc', by: 3}, {requestId: 'r1'});
      await ref.invoke({type: 'inc', by: 2}, {requestId: 'r2'});

      const log = await runtime.events(TYPE, 'a');
      expect(log.map(entry => entry.event)).toEqual([
        {type: 'Incremented', by: 3},
        {type: 'Incremented', by: 2},
      ]);
      expect(log.map(entry => entry.seq)).toEqual([0, 1]);
      expect(log.map(entry => entry.requestId)).toEqual(['r1', 'r2']);
      expect(log.every(entry => entry.actor.type === TYPE)).toBe(true);
      expect(log.every(entry => entry.actor.id === 'a')).toBe(true);
    });

    it('appends one entry per event, not per turn', async () => {
      const runtime = makeRuntime();
      const definition = defineActor('conformance.journal.multi', {
        state: JournalState,
        command: z.object({}),
        result: JournalState,
        initialState: () => ({count: 0}),
        receive(_ctx, state) {
          state.count += 1;
          return {
            state,
            result: state,
            events: [{type: 'First'}, {type: 'Second'}, {type: 'Third'}],
          };
        },
      });
      runtime.register(definition);

      await runtime.ref(definition, 'multi').invoke({}, {requestId: 'once'});

      const log = await runtime.events('conformance.journal.multi', 'multi');
      expect(log.map(entry => entry.event.type)).toEqual([
        'First',
        'Second',
        'Third',
      ]);
      // Gap-free and monotonic across a multi-event turn.
      expect(log.map(entry => entry.seq)).toEqual([0, 1, 2]);
      expect(log.every(entry => entry.requestId === 'once')).toBe(true);
    });

    it('appends nothing when a turn rolls back', async () => {
      const runtime = makeRuntime();
      const definition = journal();
      runtime.register(definition);
      const ref = runtime.ref(definition, 'b');

      await ref.invoke({type: 'inc', by: 1});
      await expect(ref.invoke({type: 'boom'})).rejects.toThrow('turn failed');

      // State, dedup and log all stand where the last good turn left them.
      expect(await runtime.state(definition, 'b')).toEqual({count: 1});
      expect(await runtime.events(TYPE, 'b')).toHaveLength(1);
    });

    it('does not re-append events on an idempotent replay', async () => {
      const runtime = makeRuntime();
      const definition = journal();
      runtime.register(definition);
      const ref = runtime.ref(definition, 'c');

      await ref.invoke({type: 'inc', by: 5}, {requestId: 'once'});
      await ref.invoke({type: 'inc', by: 5}, {requestId: 'once'});

      const log = await runtime.events(TYPE, 'c');
      expect(log).toHaveLength(1);
      expect(log[0]?.requestId).toBe('once');
      expect(await runtime.state(definition, 'c')).toEqual({count: 5});
    });

    it('commits a turn that emits no events, appending nothing', async () => {
      const runtime = makeRuntime();
      const definition = journal();
      runtime.register(definition);
      const ref = runtime.ref(definition, 'd');

      const first = await ref.invoke({type: 'quiet'}, {requestId: 'quiet-1'});
      const replay = await ref.invoke({type: 'quiet'}, {requestId: 'quiet-1'});

      expect(first).toEqual({count: 1});
      expect(replay).toEqual(first); // dedup still committed
      expect(await runtime.state(definition, 'd')).toEqual({count: 1});
      expect(await runtime.events(TYPE, 'd')).toEqual([]);

      // A later event-emitting turn still starts the log at seq 0.
      await ref.invoke({type: 'inc', by: 1});
      expect((await runtime.events(TYPE, 'd')).map(e => e.seq)).toEqual([0]);
    });

    // -- Per-seat-type deadlines (capability-os#7) ------------------------
    //
    // "A timeout is a recorded failed turn": on a runtime that has a journal,
    // the record IS a journal entry. It consumes a seq and carries the
    // requestId, and it is its own write — it touches neither state nor the
    // dedup record, so the one commit point is untouched and the requestId
    // stays retryable (see the retry case in the runtime suite).
    function hangingJournal(hangs: () => boolean) {
      return defineActor('conformance.journal.deadline', {
        state: JournalState,
        command: z.object({by: z.number()}),
        result: JournalState,
        deadlineMs: 50,
        initialState: () => ({count: 0}),
        async receive(_ctx, state, command) {
          if (hangs()) await new Promise<never>(() => {});
          state.count += command.by;
          return {
            state,
            result: state,
            events: [{type: 'Incremented', by: command.by}],
          };
        },
      });
    }

    it('journals a timed-out turn as a failed turn, and nothing else', async () => {
      const runtime = makeRuntime();
      let hangs = true;
      const definition = hangingJournal(() => hangs);
      runtime.register(definition);
      const ref = runtime.ref(definition, 'timed-out');

      await expect(
        ref.invoke({by: 1}, {requestId: 'hangs'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);

      const afterTimeout = await runtime.events(
        'conformance.journal.deadline',
        'timed-out',
      );
      expect(afterTimeout).toHaveLength(1);
      expect(afterTimeout[0]?.event.type).toBe(ACTOR_TURN_TIMEOUT_EVENT);
      expect(afterTimeout[0]?.event.deadlineMs).toBe(50);
      expect(afterTimeout[0]?.requestId).toBe('hangs');
      expect(afterTimeout[0]?.seq).toBe(0);
      // The failed turn moved no state.
      expect(await runtime.state(definition, 'timed-out')).toEqual({count: 0});

      // The marker consumed a seq, so the next real turn journals after it —
      // one append-only log, system records and domain facts in commit order.
      hangs = false;
      await ref.invoke({by: 4}, {requestId: 'hangs'});
      const afterRetry = await runtime.events(
        'conformance.journal.deadline',
        'timed-out',
      );
      expect(afterRetry.map(entry => entry.event.type)).toEqual([
        ACTOR_TURN_TIMEOUT_EVENT,
        'Incremented',
      ]);
      expect(afterRetry.map(entry => entry.seq)).toEqual([0, 1]);
      expect(await runtime.state(definition, 'timed-out')).toEqual({count: 4});
    });

    it('journals a synchronous deadline overrun as a failed turn too', async () => {
      // The commit-boundary elapsed check must produce the *same* record as
      // the timer path — otherwise a sync-heavy turn either commits despite
      // missing its deadline or (on Redis) fails as a lost lease with nothing
      // in the log to say why.
      const runtime = makeRuntime();
      let spins = true;
      const TYPE_SYNC = 'conformance.journal.deadline.sync';
      const definition = defineActor(TYPE_SYNC, {
        state: JournalState,
        command: z.object({by: z.number()}),
        result: JournalState,
        deadlineMs: 50,
        initialState: () => ({count: 0}),
        receive(_ctx, state, command) {
          if (spins) {
            const until = Date.now() + 80;
            while (Date.now() < until) {
              /* deliberately blocking */
            }
          }
          state.count += command.by;
          return {
            state,
            result: state,
            events: [{type: 'Incremented', by: command.by}],
          };
        },
      });
      runtime.register(definition);
      const ref = runtime.ref(definition, 'spun');

      await expect(
        ref.invoke({by: 1}, {requestId: 'spin'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);

      const afterTimeout = await runtime.events(TYPE_SYNC, 'spun');
      expect(afterTimeout).toHaveLength(1);
      expect(afterTimeout[0]?.event.type).toBe(ACTOR_TURN_TIMEOUT_EVENT);
      expect(afterTimeout[0]?.requestId).toBe('spin');
      expect(await runtime.state(definition, 'spun')).toEqual({count: 0});

      // Still retryable, and the log keeps advancing from the marker.
      spins = false;
      await ref.invoke({by: 4}, {requestId: 'spin'});
      expect(
        (await runtime.events(TYPE_SYNC, 'spun')).map(e => e.event.type),
      ).toEqual([ACTOR_TURN_TIMEOUT_EVENT, 'Incremented']);
      expect(await runtime.state(definition, 'spun')).toEqual({count: 4});
    });

    it('never lets a late initialState renumber or drop a journal', async () => {
      // The journal half of the same race. Resetting a stored identity would
      // restart `seq` at 0 and hand subscribers a second, different event at
      // an `(actor, seq)` pair they were already given — which the consumer
      // contract ("be idempotent by `(actor, seq)`") gives them no way to
      // detect.
      const runtime = makeRuntime();
      let slowInit = true;
      const TYPE_COLD = 'conformance.journal.cold-init';
      const definition = defineActor(TYPE_COLD, {
        state: JournalState,
        command: z.object({by: z.number()}),
        result: JournalState,
        deadlineMs: 50,
        initialState: async () => {
          if (slowInit) {
            slowInit = false;
            await new Promise<void>(resolve => setTimeout(resolve, 300));
          }
          return {count: 0};
        },
        receive(_ctx, state, command) {
          state.count += command.by;
          return {
            state,
            result: state,
            events: [{type: 'Incremented', by: command.by}],
          };
        },
      });
      runtime.register(definition);
      const ref = runtime.ref(definition, 'cold');

      await ref.invoke({by: 1}, {requestId: 'first'}).catch(() => undefined);
      await ref.invoke({by: 2}, {requestId: 'anchor'});
      const before = await runtime.events(TYPE_COLD, 'cold');
      expect(before.length).toBeGreaterThan(0);

      // Past the slow initialState's own resolution.
      await new Promise<void>(resolve => setTimeout(resolve, 400));

      // Nothing lost and nothing renumbered.
      expect(await runtime.events(TYPE_COLD, 'cold')).toEqual(before);

      // And the log keeps advancing from where it stood — no seq collision.
      await ref.invoke({by: 3}, {requestId: 'later'});
      const seqs = (await runtime.events(TYPE_COLD, 'cold')).map(e => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    });

    it('journals a nested timeout once, on the inner actor log only', async () => {
      // One incident, one marker. An inner `TurnTimeoutError` passes through
      // the outer turn's frame on its way to the caller; a runtime that
      // recorded on error type alone would append a *second* marker — to the
      // inner actor's own log, consuming another seq — from the outer frame,
      // while the outer turn (an ordinary rollback) got none.
      const runtime = makeRuntime();
      const {outer} = nested(runtime);

      await expect(
        runtime.ref(outer, 'caller').invoke({}, {requestId: 'outer-call'}),
      ).rejects.toBeInstanceOf(TurnTimeoutError);

      const innerLog = await runtime.events(
        'conformance.deadline.inner',
        'hangs',
      );
      expect(innerLog).toHaveLength(1);
      expect(innerLog[0]?.event.type).toBe(ACTOR_TURN_TIMEOUT_EVENT);
      expect(innerLog[0]?.requestId).toBe('nested');

      // The caller's own log stays empty: it rolled back, it did not time out.
      expect(
        await runtime.events('conformance.deadline.outer', 'caller'),
      ).toEqual([]);
    });

    it('keeps each identity log independent', async () => {
      const runtime = makeRuntime();
      const definition = journal();
      runtime.register(definition);

      await runtime.ref(definition, 'x').invoke({type: 'inc', by: 1});

      expect(await runtime.events(TYPE, 'y')).toEqual([]);
      expect((await runtime.events(TYPE, 'x')).map(e => e.seq)).toEqual([0]);
    });

    it('reads an unknown identity log as empty', async () => {
      const runtime = makeRuntime();
      runtime.register(journal());
      expect(await runtime.events(TYPE, 'never-addressed')).toEqual([]);
    });

    // Every case above uses a raw `defineActor` whose `receive` never sets
    // `ctx.seatKeyId`, so each entry they journal carries the `''` sentinel:
    // they prove the runtime plumbs the field, not that a real key row ever
    // reaches it. These two go through ActorRegistry + a real @actor, the
    // same path a production app uses, so `ensureSeatKey`'s result is what
    // actually lands on the committed event.
    it("stamps the acting seat's key row id on the committed event (registry-driven, key store bound)", async () => {
      const runtime = makeRuntime();
      const app = new Application();
      app.bind(ACTOR_RUNTIME).to(runtime);
      app.service(ActorRegistry);
      app.bind(SEAT_KEY_STORE_KEK).to(randomBytes(32));
      app.service(InMemorySeatKeyStore);
      app.service(SeatedJournalActor);
      await app.start();

      const registry = await app.get(ACTOR_REGISTRY);
      const store = await app.get(SEAT_KEY_STORE);
      const seated: ActorId = {
        type: 'conformance.journal.seated',
        id: 'seated-a',
      };

      await registry.invoke(
        seated.type,
        seated.id,
        {name: 'go', input: {}},
        {requestId: 'r1'},
      );

      const record = await store.getByActor(seated);
      const log = await registry.events(seated.type, seated.id);

      expect(record?.seatKeyId).toBeTruthy();
      expect(log).toHaveLength(1);
      expect(log[0]?.seatKeyId).toBe(record?.seatKeyId);
      await app.stop();
    });

    it("carries the '' sentinel on the committed event when no key store is bound (registry-driven)", async () => {
      const runtime = makeRuntime();
      const app = new Application();
      app.bind(ACTOR_RUNTIME).to(runtime);
      app.service(ActorRegistry);
      app.service(SeatedJournalActor);
      await app.start();

      const registry = await app.get(ACTOR_REGISTRY);
      const seated: ActorId = {
        type: 'conformance.journal.seated',
        id: 'seated-b',
      };

      await registry.invoke(
        seated.type,
        seated.id,
        {name: 'go', input: {}},
        {requestId: 'r1'},
      );

      const log = await registry.events(seated.type, seated.id);
      expect(log).toHaveLength(1);
      expect(log[0]?.seatKeyId).toBe('');
      await app.stop();
    });
  });
}

export interface SeatKeyStoreConformanceOptions {
  /**
   * Open a second view over the **same** backing storage under a different
   * KEK — the shape of a rotated or mis-configured key. Supply it and the
   * suite additionally pins that a failed decrypt does not consume the
   * one-shot export.
   *
   * Optional because only an adapter whose storage lives outside the instance
   * can express it. `InMemorySeatKeyStore` keeps its records in the object
   * itself, so a second instance is a second, empty store; it covers the same
   * invariant in `seat-key-store.unit.ts` instead.
   */
  reopenWithWrongKek?: (store: SeatKeyStore) => SeatKeyStore;
}

/**
 * Behavioral contract required of every `seat.keyStore` adapter
 * (capability-os#5: custodial keypair at birth, dormant). `makeStore` must
 * return a fresh, empty store on each call.
 */
export function runSeatKeyStoreConformance(
  name: string,
  makeStore: () => SeatKeyStore,
  options: SeatKeyStoreConformanceOptions = {},
): void {
  describe(`SeatKeyStore conformance: ${name}`, () => {
    const actorA: ActorId = {type: 'conformance.seat', id: 'a'};
    const actorB: ActorId = {type: 'conformance.seat', id: 'b'};

    it('exposes no sign method on the store surface', () => {
      const store = makeStore();
      expect('sign' in store).toBe(false);
    });

    it('creating a seat yields a dormant key row', async () => {
      const store = makeStore();
      const record = await store.create(actorA);
      expect(record.seatKeyId).toMatch(/^[0-9a-f]{64}$/);
      expect(record.publicKey).toMatch(/^[0-9a-f]{66}$/);
      expect(record.exportedAt).toBeNull();
      expect('encryptedPrivateKey' in record).toBe(false);
    });

    it('is idempotent — an identity that already has a key row never regenerates', async () => {
      const store = makeStore();
      const first = await store.create(actorA);
      const second = await store.create(actorA);
      expect(second).toEqual(first);

      const other = await store.create(actorB);
      expect(other.seatKeyId).not.toBe(first.seatKeyId);
    });

    it('getByActor resolves the same record as get(seatKeyId)', async () => {
      const store = makeStore();
      const created = await store.create(actorA);
      expect(await store.getByActor(actorA)).toEqual(created);
      expect(await store.get(created.seatKeyId)).toEqual(created);
    });

    it('getByActor / get return undefined for an unknown identity', async () => {
      const store = makeStore();
      expect(await store.getByActor(actorA)).toBeUndefined();
      expect(await store.get('unknown-seat-key-id')).toBeUndefined();
    });

    it('records ownerAccountId when provided, omits it when not', async () => {
      const store = makeStore();
      const owned = await store.create(actorA, {ownerAccountId: 'acct_1'});
      expect(owned.ownerAccountId).toBe('acct_1');

      const unowned = await store.create(actorB);
      expect(unowned.ownerAccountId).toBeUndefined();
    });

    it('takeCustody returns the private key exactly once, then fails', async () => {
      const store = makeStore();
      const record = await store.create(actorA);

      const privateKey = await store.takeCustody(record.seatKeyId);
      expect(privateKey).toMatch(/^[0-9a-f]{64}$/);

      await expect(store.takeCustody(record.seatKeyId)).rejects.toThrow();
    });

    it('takeCustody returns the private key that actually matches the stored publicKey', async () => {
      // A shape-only regex on the returned hex string would pass for an
      // adapter returning unrelated random bytes. Re-derive the public key
      // from the exported private key on the real curve and compare — this
      // also pins the private-key zero-padding fix (a stripped leading zero
      // byte would derive the wrong point).
      const store = makeStore();
      const record = await store.create(actorA);
      const privateKeyHex = await store.takeCustody(record.seatKeyId);

      const ecdh = createECDH('secp256k1');
      ecdh.setPrivateKey(Buffer.from(privateKeyHex, 'hex'));
      const derivedPublicKey = ecdh
        .getPublicKey(null, 'compressed')
        .toString('hex');
      expect(derivedPublicKey).toBe(record.publicKey);
    });

    it('takeCustody marks the row exported', async () => {
      const store = makeStore();
      const record = await store.create(actorA);
      expect((await store.get(record.seatKeyId))?.exportedAt).toBeNull();

      await store.takeCustody(record.seatKeyId);

      expect((await store.get(record.seatKeyId))?.exportedAt).not.toBeNull();
    });

    it('takeCustody on an unknown seatKeyId fails', async () => {
      const store = makeStore();
      await expect(store.takeCustody('does-not-exist')).rejects.toThrow();
    });

    const describeRekey = options.reopenWithWrongKek ? describe : describe.skip;
    describeRekey('under a wrong or rotated KEK', () => {
      it('does not consume the one-shot when the decrypt fails', async () => {
        // The escape hatch must not burn itself down on a misconfiguration.
        // A store that marked the row exported before decrypting would leave
        // the key unrecoverable forever, from a single bad KEK.
        const store = makeStore();
        const record = await store.create(actorA);
        const wrongKek = options.reopenWithWrongKek!(store);

        await expect(store.get(record.seatKeyId)).resolves.toBeDefined();
        await expect(wrongKek.takeCustody(record.seatKeyId)).rejects.toThrow();

        // Untouched: still dormant, and still exportable with the real KEK.
        expect((await store.get(record.seatKeyId))?.exportedAt).toBeNull();
        await expect(store.takeCustody(record.seatKeyId)).resolves.toMatch(
          /^[0-9a-f]{64}$/,
        );
      });
    });

    it('yields exactly one winner when takeCustody races itself', async () => {
      // Reordering decrypt ahead of the mark must not weaken exactly-once:
      // the mark is still an atomic compare-and-set, so a loser throws rather
      // than returning the key it already decrypted.
      const store = makeStore();
      const record = await store.create(actorA);

      const outcomes = await Promise.allSettled([
        store.takeCustody(record.seatKeyId),
        store.takeCustody(record.seatKeyId),
        store.takeCustody(record.seatKeyId),
      ]);

      const won = outcomes.filter(o => o.status === 'fulfilled');
      expect(won).toHaveLength(1);
      expect((won[0] as PromiseFulfilledResult<string>).value).toMatch(
        /^[0-9a-f]{64}$/,
      );
    });
  });
}
