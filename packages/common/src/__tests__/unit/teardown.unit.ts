// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, expect, it} from 'vitest';
import {composeTeardown} from '../../utils/teardown.js';

describe('composeTeardown', () => {
  it('runs disposers in reverse registration order', async () => {
    const order: string[] = [];
    const td = composeTeardown();
    td.push(() => void order.push('first'));
    td.push(() => void order.push('second'));
    td.push(() => void order.push('third'));

    await td.run();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('awaits async disposers before running the next one', async () => {
    const order: string[] = [];
    const td = composeTeardown();
    td.push(() => void order.push('sync'));
    td.push(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('async');
    });

    await td.run();

    expect(order).toEqual(['async', 'sync']);
  });

  it('is idempotent: a second run() does not re-run disposers', async () => {
    let calls = 0;
    const td = composeTeardown();
    td.push(() => void calls++);

    await td.run();
    await td.run();

    expect(calls).toBe(1);
  });

  it('runs every disposer even when one throws, then rejects with an AggregateError', async () => {
    const order: string[] = [];
    const td = composeTeardown();
    td.push(() => void order.push('first'));
    td.push(() => {
      throw new Error('boom');
    });
    td.push(() => void order.push('third'));

    await expect(td.run()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(1);
      expect(((err as AggregateError).errors[0] as Error).message).toBe('boom');
      return true;
    });
    expect(order).toEqual(['third', 'first']);
  });
});
