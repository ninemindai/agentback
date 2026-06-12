// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {Application} from '@agentback/core';
import {describe, expect, it} from 'vitest';
import {DrizzleBindings, registerDrizzle} from '../../index.js';

/** Stand-in for a Drizzle database instance — registerDrizzle is generic. */
function fakeDb(name: string) {
  return {name, select: () => []};
}

describe('DrizzleBindings', () => {
  it('exposes the default CLIENT key', () => {
    expect(DrizzleBindings.CLIENT.key).toBe('datasources.drizzle');
  });

  it('derives keys for named datasources', () => {
    expect(DrizzleBindings.datasource('analytics').key).toBe(
      'datasources.analytics',
    );
  });
});

describe('registerDrizzle', () => {
  it('binds the client under the default key, retrievable as the same instance', async () => {
    const app = new Application();
    const db = fakeDb('primary');
    const binding = registerDrizzle(app, db);

    expect(binding.key).toBe(DrizzleBindings.CLIENT.key);
    expect(await app.get(DrizzleBindings.CLIENT)).toBe(db);
    // Constant binding: repeated resolution yields the same instance.
    expect(await app.get(DrizzleBindings.CLIENT)).toBe(db);
  });

  it('supports multiple named datasources via the key option', async () => {
    const app = new Application();
    const primary = fakeDb('primary');
    const analytics = fakeDb('analytics');
    const reporting = fakeDb('reporting');

    registerDrizzle(app, primary);
    registerDrizzle(app, analytics, {
      key: DrizzleBindings.datasource('analytics'),
    });
    registerDrizzle(app, reporting, {key: 'datasources.reporting'});

    expect(await app.get(DrizzleBindings.CLIENT)).toBe(primary);
    expect(await app.get(DrizzleBindings.datasource('analytics'))).toBe(
      analytics,
    );
    expect(await app.get('datasources.reporting')).toBe(reporting);
  });

  it('invokes onStop exactly once across double app.stop()', async () => {
    const app = new Application();
    let calls = 0;
    registerDrizzle(app, fakeDb('primary'), {
      onStop: () => {
        calls++;
      },
    });

    await app.start();
    await app.stop();
    await app.stop();
    expect(calls).toBe(1);
  });

  it('keeps onStop idempotent across restart cycles', async () => {
    const app = new Application();
    let calls = 0;
    registerDrizzle(app, fakeDb('primary'), {
      onStop: async () => {
        calls++;
      },
    });

    await app.start();
    await app.stop();
    // Pools cannot be re-opened after end(); the guard must hold even if the
    // application itself is restarted and stopped again.
    await app.start();
    await app.stop();
    expect(calls).toBe(1);
  });

  it('registers one observer per registration (multi-db shutdown)', async () => {
    const app = new Application();
    const stopped: string[] = [];
    registerDrizzle(app, fakeDb('primary'), {
      onStop: () => {
        stopped.push('primary');
      },
    });
    registerDrizzle(app, fakeDb('analytics'), {
      key: DrizzleBindings.datasource('analytics'),
      onStop: () => {
        stopped.push('analytics');
      },
    });

    await app.start();
    await app.stop();
    expect(stopped.sort()).toEqual(['analytics', 'primary']);
  });

  it('registers no observer when onStop is omitted', async () => {
    const app = new Application();
    registerDrizzle(app, fakeDb('primary'));
    await app.start();
    await expect(app.stop()).resolves.toBeUndefined();
  });
});
