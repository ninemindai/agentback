// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {installSteps, type Disposer} from '../../utils/install-steps.js';

describe('installSteps', () => {
  it('returns the generator value and does not revert on success', async () => {
    const reverted: string[] = [];
    const {value, teardown} = await installSteps(async function* () {
      yield () => void reverted.push('a');
      yield () => void reverted.push('b');
      return {base: '/console'};
    });

    expect(value).toEqual({base: '/console'});
    expect(reverted).toEqual([]);

    await teardown.run();
    expect(reverted).toEqual(['b', 'a']);
  });

  it('reverts already-yielded steps in LIFO order when a later step throws', async () => {
    const reverted: string[] = [];
    const attempt = installSteps(async function* () {
      yield () => void reverted.push('first');
      yield () => void reverted.push('second');
      throw new Error('third step failed');
    });

    await expect(attempt).rejects.toThrow('third step failed');
    expect(reverted).toEqual(['second', 'first']);
  });

  it('covers the step immediately after a yield', async () => {
    // The guarantee that distinguishes this from `return a disposer at the
    // end`: a throw on the very next line still reverts the step before it.
    const reverted: string[] = [];
    const attempt = installSteps(async function* () {
      const gate = {off: () => void reverted.push('gate')};
      yield () => gate.off();
      throw new Error('mount failed');
    });

    await expect(attempt).rejects.toThrow('mount failed');
    expect(reverted).toEqual(['gate']);
  });

  it('reverts nothing when the first step throws before yielding', async () => {
    const reverted: string[] = [];
    const attempt = installSteps(async function* (): AsyncGenerator<
      Disposer,
      void,
      void
    > {
      if (reverted.length === 0) throw new Error('nothing landed');
      yield () => void reverted.push('unreachable');
    });

    await expect(attempt).rejects.toThrow('nothing landed');
    expect(reverted).toEqual([]);
  });

  it('awaits between steps and reverts the awaited work', async () => {
    const order: string[] = [];
    const attempt = installSteps(async function* () {
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('installed-async');
      yield () => void order.push('reverted-async');
      throw new Error('later failure');
    });

    await expect(attempt).rejects.toThrow('later failure');
    expect(order).toEqual(['installed-async', 'reverted-async']);
  });

  it('rethrows the install error, not the rollback error, when a disposer fails', async () => {
    // A rollback that also fails must not replace the diagnosis: the caller
    // asked about the install, and swapping in an AggregateError would break
    // their error handling exactly when it matters most.
    const reverted: string[] = [];
    const attempt = installSteps(async function* () {
      yield () => void reverted.push('survivor');
      yield () => {
        throw new Error('disposer exploded');
      };
      throw new Error('install failed');
    });

    await expect(attempt).rejects.toThrow('install failed');
    // The remaining disposers still run — composeTeardown does not stop early.
    expect(reverted).toEqual(['survivor']);
  });

  it('makes a failed rollback visible on the thrown error with zero config', async () => {
    // loggers() is debug-namespaced, so log.error alone emits nothing unless
    // DEBUG matches — a log-only rollback failure is the `.catch(() => {})`
    // this replaced. The failure must ride on the error the caller already has.
    const attempt = installSteps(async function* () {
      yield () => {
        throw new Error('disposer exploded');
      };
      throw new Error('install failed');
    });

    const err = (await attempt.catch((e: unknown) => e)) as Error & {
      rollbackFailure?: unknown;
    };
    expect(err).toBeInstanceOf(Error);
    // Visible in any printer that shows a message.
    expect(err.message).toContain('install failed');
    expect(err.message).toContain('rollback also failed');
    expect(err.message).toContain('disposer exploded');
    // And inspectable programmatically. composeTeardown aggregates, so the
    // attached value is the AggregateError carrying each failed disposer.
    expect(err.rollbackFailure).toBeInstanceOf(AggregateError);
    expect(
      ((err.rollbackFailure as AggregateError).errors[0] as Error).message,
    ).toBe('disposer exploded');
    expect(err.cause).toBe(err.rollbackFailure);
  });

  it('does not clobber an existing cause chain', async () => {
    const original = new Error('install failed');
    original.cause = new Error('the real root cause');
    const attempt = installSteps(async function* () {
      yield () => {
        throw new Error('disposer exploded');
      };
      throw original;
    });

    const err = (await attempt.catch((e: unknown) => e)) as Error;
    expect((err.cause as Error).message).toBe('the real root cause');
    const attached = (err as {rollbackFailure?: AggregateError})
      .rollbackFailure!;
    expect((attached.errors[0] as Error).message).toBe('disposer exploded');
  });
});
