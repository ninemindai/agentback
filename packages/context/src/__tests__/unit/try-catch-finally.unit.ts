// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';

import {tryCatchFinally, tryWithFinally} from '../../index.js';

describe('tryWithFinally', () => {
  it('performs final action for a fulfilled promise', async () => {
    let finalActionInvoked = false;
    const action = () => Promise.resolve(1);
    const finalAction = () => (finalActionInvoked = true);
    await tryWithFinally(action, finalAction);
    expect(finalActionInvoked).toBe(true);
  });

  it('performs final action for a resolved value', () => {
    let finalActionInvoked = false;
    const action = () => 1;
    const finalAction = () => (finalActionInvoked = true);

    tryWithFinally(action, finalAction);
    expect(finalActionInvoked).toBe(true);
  });

  it('performs final action for a rejected promise', async () => {
    let finalActionInvoked = false;
    const action = () => Promise.reject(new Error('error'));
    const finalAction = () => (finalActionInvoked = true);
    await expect(tryWithFinally(action, finalAction)).rejects.toThrow('error');
    expect(finalActionInvoked).toBe(true);
  });

  it('performs final action for an action that throws an error', () => {
    let finalActionInvoked = false;
    const action = () => {
      throw new Error('error');
    };
    const finalAction = () => (finalActionInvoked = true);
    expect(() => tryWithFinally(action, finalAction)).toThrow('error');
    expect(finalActionInvoked).toBe(true);
  });
});

describe('tryCatchFinally', () => {
  it('performs final action for a fulfilled promise', async () => {
    let finalActionInvoked = false;
    const action = () => Promise.resolve(1);
    const finalAction = () => (finalActionInvoked = true);
    await tryCatchFinally(action, undefined, finalAction);
    expect(finalActionInvoked).toBe(true);
  });

  it('performs final action for a resolved value', () => {
    let finalActionInvoked = false;
    const action = () => 1;
    const finalAction = () => (finalActionInvoked = true);

    tryCatchFinally(action, undefined, finalAction);
    expect(finalActionInvoked).toBe(true);
  });

  it('skips error action for a fulfilled promise', async () => {
    let errorActionInvoked = false;
    const action = () => Promise.resolve(1);
    const errorAction = (err: unknown) => {
      errorActionInvoked = true;
      throw err;
    };
    await tryCatchFinally(action, errorAction);
    expect(errorActionInvoked).toBe(false);
  });

  it('skips error action for a resolved value', () => {
    let errorActionInvoked = false;
    const action = () => 1;
    const errorAction = (err: unknown) => {
      errorActionInvoked = true;
      throw err;
    };

    tryCatchFinally(action, errorAction);
    expect(errorActionInvoked).toBe(false);
  });

  it('performs error action for a rejected promise', async () => {
    let errorActionInvoked = false;
    const errorAction = (err: unknown) => {
      errorActionInvoked = true;
      throw err;
    };
    const action = () => Promise.reject(new Error('error'));
    const finalAction = () => true;
    await expect(
      tryCatchFinally(action, errorAction, finalAction),
    ).rejects.toThrow('error');
    expect(errorActionInvoked).toBe(true);
  });

  it('performs error action for an action that throws an error', () => {
    let errorActionInvoked = false;
    const errorAction = (err: unknown) => {
      errorActionInvoked = true;
      throw err;
    };
    const action = () => {
      throw new Error('error');
    };
    const finalAction = () => true;
    expect(() => tryCatchFinally(action, errorAction, finalAction)).toThrow(
      'error',
    );
    expect(errorActionInvoked).toBe(true);
  });

  it('allows error action to return a value for a rejected promise', async () => {
    let errorActionInvoked = false;
    const errorAction = (err: unknown) => {
      errorActionInvoked = true;
      return 1;
    };
    const action = () => Promise.reject(new Error('error'));
    const result = await tryCatchFinally(action, errorAction);
    expect(errorActionInvoked).toBe(true);
    expect(result).toBe(1);
  });

  it('allows error action to return a value for an action that throws an error', () => {
    let errorActionInvoked = false;
    const errorAction = (err: unknown) => {
      errorActionInvoked = true;
      return 1;
    };
    const action = () => {
      throw new Error('error');
    };
    const result = tryCatchFinally(action, errorAction);
    expect(result).toBe(1);
    expect(errorActionInvoked).toBe(true);
  });

  it('skips error action for rejection from the final action', async () => {
    let errorActionInvoked = false;
    const errorAction = (err: unknown) => {
      errorActionInvoked = true;
      throw err;
    };
    const action = () => Promise.resolve(1);
    const finalAction = () => {
      throw new Error('error');
    };
    await expect(
      tryCatchFinally(action, errorAction, finalAction),
    ).rejects.toThrow('error');
    expect(errorActionInvoked).toBe(false);
  });

  it('skips error action for error from the final action', () => {
    let errorActionInvoked = false;
    const errorAction = (err: unknown) => {
      errorActionInvoked = true;
      throw err;
    };
    const action = () => 1;
    const finalAction = () => {
      throw new Error('error');
    };
    expect(() => tryCatchFinally(action, errorAction, finalAction)).toThrow(
      'error',
    );
    expect(errorActionInvoked).toBe(false);
  });

  it('allows default error action', () => {
    const action = () => {
      throw new Error('error');
    };
    expect(() => tryCatchFinally(action)).toThrow('error');
  });

  it('allows default error action for rejected promise', () => {
    const action = () => {
      return Promise.reject(new Error('error'));
    };
    return expect(tryCatchFinally(action)).rejects.toThrow('error');
  });
});
