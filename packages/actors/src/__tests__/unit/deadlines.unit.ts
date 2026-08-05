// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {MetadataInspector} from '@agentback/metadata';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {SEAT_CLASS_DEADLINE_MS, TurnTimeoutError} from '../../deadlines.js';
import {actor, actorCommand} from '../../decorators.js';
import {defineActor} from '../../define-actor.js';
import {ActorMetadata, type ActorClassMetadata} from '../../keys.js';
import type {Actor, ActorTurn} from '../../types.js';

const Empty = z.object({});

function define(options: {
  seatClass?: 'capability' | 'worker';
  deadlineMs?: number;
}) {
  return defineActor('deadlines.fixture', {
    state: Empty,
    command: Empty,
    result: Empty,
    initialState: () => ({}),
    receive: (_ctx, state) => ({state, result: {}}),
    ...options,
  });
}

describe('per-seat-type deadlines', () => {
  it('bands the two seat classes at 30s and 10min', () => {
    expect(SEAT_CLASS_DEADLINE_MS).toEqual({
      capability: 30_000,
      worker: 600_000,
    });
  });

  it('defaults an undeclared definition to the capability band', () => {
    const definition = define({});
    expect(definition.seatClass).toBe('capability');
    expect(definition.deadlineMs).toBe(30_000);
  });

  it('gives a worker seat the 10-minute band', () => {
    const definition = define({seatClass: 'worker'});
    expect(definition.seatClass).toBe('worker');
    expect(definition.deadlineMs).toBe(600_000);
  });

  it('lets an explicit deadlineMs win over the seat class default', () => {
    expect(define({deadlineMs: 250}).deadlineMs).toBe(250);
    expect(define({seatClass: 'worker', deadlineMs: 250}).deadlineMs).toBe(250);
    // …and the class it overrides is still visible on the definition.
    expect(define({seatClass: 'worker', deadlineMs: 250}).seatClass).toBe(
      'worker',
    );
  });

  it('rejects a deadline no timer could honor', () => {
    for (const deadlineMs of [0, -1, Number.NaN, Infinity]) {
      expect(() => define({deadlineMs})).toThrow('deadlineMs');
    }
  });

  it('carries the seat class declared on @actor through to the definition', () => {
    @actor('deadlines.decorated', {state: Empty, seatClass: 'worker'})
    class WorkerActor implements Actor<Record<string, never>> {
      initialState(): Record<string, never> {
        return {};
      }

      @actorCommand('go', {input: Empty, output: Empty})
      go(state: Record<string, never>): ActorTurn<Record<string, never>, {}> {
        return {state, result: {}};
      }
    }

    const metadata = MetadataInspector.getClassMetadata<ActorClassMetadata>(
      ActorMetadata.CLASS,
      WorkerActor,
    );
    expect(metadata?.seatClass).toBe('worker');
    expect(metadata?.deadlineMs).toBeUndefined();
  });

  it('rejects a bad @actor deadline at decoration time, naming nothing else', () => {
    expect(() =>
      actor('deadlines.bad', {state: Empty, deadlineMs: -1}),
    ).toThrow('deadlineMs');
  });

  it('names the actor, request and deadline in the timeout error', () => {
    const error = new TurnTimeoutError({type: 'seat', id: 'one'}, 'r1', 50);
    expect(error.name).toBe('TurnTimeoutError');
    expect(error.code).toBe('actor_turn_timeout');
    expect(error.message).toContain('seat/one');
    expect(error.message).toContain('r1');
    expect(error.message).toContain('50ms');
  });
});
