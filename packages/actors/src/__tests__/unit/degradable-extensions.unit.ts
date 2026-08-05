// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {
  Application,
  ContextView,
  extensionFilter,
  extensionFor,
  extensions,
} from '@agentback/core';
import {enableDebug, LogLevel, onLog} from '@agentback/common';
import {describe, expect, it} from 'vitest';
import {
  collectValidatedExtensions,
  dispatchToExtensions,
} from '../../degradable-extensions.js';
import {
  SEAT_JOURNAL_ARCHIVER,
  SEAT_JOURNAL_CONSUMER,
  SeatJournalArchiverContract,
  SeatJournalConsumerContract,
  SeatKeyRecordSchema,
  SeatKeyStoreContract,
} from '../../keys.js';
import type {CommittedActorEvent} from '../../types.js';

// `log.error(...)` is a no-op unless its debug namespace is enabled (the
// `debug` package's own gate, which `onLog` hooks sit behind) — enable it so
// the "failure visible in the log" gate can actually observe the calls.
enableDebug('agentback:actors:extensions:*');

const event: CommittedActorEvent = {
  actor: {type: 'seat', id: 'one'},
  seq: 0,
  requestId: 'r1',
  event: {type: 'created'},
};

/** Collect warn/error log calls for one namespace prefix while `fn` runs. */
async function captureLogs(
  namespacePrefix: string,
  fn: () => Promise<void>,
): Promise<{namespace: string; level: LogLevel; args: unknown[]}[]> {
  const captured: {namespace: string; level: LogLevel; args: unknown[]}[] = [];
  const dispose = onLog((namespace, level, args) => {
    if (namespace.startsWith(namespacePrefix)) {
      captured.push({namespace, level, args});
    }
  });
  try {
    await fn();
  } finally {
    dispose();
  }
  return captured;
}

/**
 * A host that reacts to plug/unplug via `@extensions.view()`, mirroring the
 * shape a real archiver/consumer host (e.g. Task 2's Beadle consumer) would
 * take.
 */
class FixtureHost {
  constructor(
    @extensions.view(SEAT_JOURNAL_ARCHIVER)
    readonly archivers: ContextView<object>,
  ) {}
}

describe('degradable extensions: seat.journal.archiver / seat.journal.consumer', () => {
  it('rejects a provider that fails contract validation at registration, leaving the host functional', async () => {
    const app = new Application();
    app.bind('fixture.host').toClass(FixtureHost);
    app
      .bind('archivers.good')
      .to({provider: 'good', archive: async () => {}})
      .apply(extensionFor(SEAT_JOURNAL_ARCHIVER));
    // Deliberately broken: no `archive` function at all.
    app
      .bind('archivers.broken')
      .to({provider: 'broken'})
      .apply(extensionFor(SEAT_JOURNAL_ARCHIVER));

    const host = await app.get<FixtureHost>('fixture.host');

    const logs = await captureLogs('agentback:actors:extensions', async () => {
      const providers = await collectValidatedExtensions(
        host.archivers,
        SEAT_JOURNAL_ARCHIVER,
        SeatJournalArchiverContract,
      );
      // The broken provider is excluded, not thrown — the host stays usable
      // and the good provider is still discovered.
      expect(providers).toEqual([
        {provider: 'good', archive: expect.any(Function)},
      ]);
    });

    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe(LogLevel.ERROR);
    expect(logs[0].args.join(' ')).toContain('archivers.broken');
    expect(logs[0].args.join(' ')).toContain('rejected at registration');
  });

  it('degrades a provider that throws at runtime to skip + log, leaving other providers running', async () => {
    const app = new Application();
    let goodCalls = 0;
    app
      .bind('archivers.good')
      .to({
        provider: 'good',
        archive: async () => {
          goodCalls++;
        },
      })
      .apply(extensionFor(SEAT_JOURNAL_ARCHIVER));
    app
      .bind('archivers.throws')
      .to({
        provider: 'throws',
        archive: async () => {
          throw new Error('boom');
        },
      })
      .apply(extensionFor(SEAT_JOURNAL_ARCHIVER));

    const view = app.createView<object>(extensionFilter(SEAT_JOURNAL_ARCHIVER));
    const providers = await collectValidatedExtensions(
      view,
      SEAT_JOURNAL_ARCHIVER,
      SeatJournalArchiverContract,
    );
    expect(providers).toHaveLength(2);

    const logs = await captureLogs('agentback:actors:extensions', async () => {
      await expect(
        dispatchToExtensions(providers, SEAT_JOURNAL_ARCHIVER, p =>
          p.archive([event]),
        ),
      ).resolves.toBeUndefined();
    });

    // The throwing provider never killed the dispatch — the good provider
    // still ran, and the failure is visible in the log.
    expect(goodCalls).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe(LogLevel.ERROR);
    expect(logs[0].args.join(' ')).toContain('throws');
    expect(logs[0].args.join(' ')).toContain('threw at runtime');
  });

  it('applies the same registration + runtime degrade discipline to seat.journal.consumer', async () => {
    const app = new Application();
    let consumed = 0;
    app
      .bind('consumers.good')
      .to({
        provider: 'good',
        consume: () => {
          consumed++;
        },
      })
      .apply(extensionFor(SEAT_JOURNAL_CONSUMER));
    // Deliberately broken: `consume` is not a function.
    app
      .bind('consumers.broken')
      .to({provider: 'broken', consume: 'nope'})
      .apply(extensionFor(SEAT_JOURNAL_CONSUMER));
    app
      .bind('consumers.throws')
      .to({
        provider: 'throws',
        consume: () => {
          throw new Error('kaboom');
        },
      })
      .apply(extensionFor(SEAT_JOURNAL_CONSUMER));

    const view = app.createView<object>(extensionFilter(SEAT_JOURNAL_CONSUMER));
    const providers = await collectValidatedExtensions(
      view,
      SEAT_JOURNAL_CONSUMER,
      SeatJournalConsumerContract,
    );
    // consumers.broken excluded at registration; the other two survive.
    expect(providers.map(p => p.provider).sort()).toEqual(['good', 'throws']);

    await expect(
      dispatchToExtensions(providers, SEAT_JOURNAL_CONSUMER, p =>
        p.consume(event),
      ),
    ).resolves.toBeUndefined();
    expect(consumed).toBe(1);
  });
});

describe('seat.keyStore contract', () => {
  it('accepts a well-formed store and a well-formed key record', () => {
    const store = {
      put: async () => {},
      get: async () => undefined,
      takeCustody: async () => 'private-key-material',
    };
    expect(SeatKeyStoreContract.safeParse(store).success).toBe(true);

    const record = {
      seatKeyId: 'sk_1',
      ownerAccountId: 'acct_1',
      publicKey: 'pub',
      encryptedPrivateKey: 'enc',
      exportedAt: null,
    };
    expect(SeatKeyRecordSchema.safeParse(record).success).toBe(true);
  });

  it('rejects a store missing part of the callable surface', () => {
    const incomplete = {put: async () => {}, get: async () => undefined};
    expect(SeatKeyStoreContract.safeParse(incomplete).success).toBe(false);
  });
});
