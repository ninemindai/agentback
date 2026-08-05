// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {BindingKey} from '@agentback/core';
import {MetadataAccessor} from '@agentback/metadata';
import {z, type ZodType} from 'zod';
import type {ActorSeatClass} from './deadlines.js';
import type {ActorRegistry} from './registry.js';
import type {ActorId, ActorRuntime, CommittedActorEvent} from './types.js';

export const ACTOR_RUNTIME = BindingKey.create<ActorRuntime>('actors.runtime');
export const ACTOR_REGISTRY =
  BindingKey.create<ActorRegistry>('actors.registry');

/** Extension point for service classes marked with `@actor()`. */
export const ACTOR_EXTENSIONS = 'actors.extensions';

// -- seat.journal.archiver / seat.journal.consumer (extension points) ------
//
// Both compose N providers, ordered by binding comparator. Each provider's
// contract is Zod-validated when the host discovers it (registration time);
// a provider that fails validation is excluded from the active set, and a
// validated provider that throws when called degrades to skip + log — in
// neither case does the host stop working. See
// `degradable-extensions.ts` for the shared validate/dispatch machinery and
// `__tests__/unit/degradable-extensions.unit.ts` for the conformance gate.

/**
 * Extension point for `seat.journal.archiver` providers (Postgres archival,
 * export, signing, ...). No provider ships in v1 — this is the seam only.
 */
export const SEAT_JOURNAL_ARCHIVER = 'seat.journal.archiver';

/**
 * Extension point for `seat.journal.consumer` providers (projections,
 * webhooks, recall index, ...). The Beadle consumer and its delivery
 * machinery are defined later; this is the seam + contract shape only.
 */
export const SEAT_JOURNAL_CONSUMER = 'seat.journal.consumer';

/**
 * Contract every `seat.journal.archiver` provider must satisfy. Validated
 * against the raw bound value at registration time — a provider that fails
 * this shape is excluded from the active set (never accepted, never crashes
 * the host).
 */
export const SeatJournalArchiverContract = z.object({
  /** Stable provider name, used in log messages when it is skipped. */
  provider: z.string().min(1),
  /** Archives one batch of committed events. */
  archive: z.custom<(events: readonly CommittedActorEvent[]) => Promise<void>>(
    value => typeof value === 'function',
    {
      message: 'archive must be a function',
    },
  ),
});
export type SeatJournalArchiverProvider = z.infer<
  typeof SeatJournalArchiverContract
>;

/**
 * Contract every `seat.journal.consumer` provider must satisfy. Validated
 * against the raw bound value at registration time — a provider that fails
 * this shape is excluded from the active set (never accepted, never crashes
 * the host).
 */
export const SeatJournalConsumerContract = z.object({
  /** Stable provider name, used in log messages when it is skipped. */
  provider: z.string().min(1),
  /** Consumes one committed event, idempotently by `(actor, seq)`. */
  consume: z.custom<(event: CommittedActorEvent) => void | Promise<void>>(
    value => typeof value === 'function',
    {
      message: 'consume must be a function',
    },
  ),
});
export type SeatJournalConsumerProvider = z.infer<
  typeof SeatJournalConsumerContract
>;

// -- seat.keyStore (port) ----------------------------------------------
//
// Exactly one provider, selected by this binding key. Task 4 implements the
// store (in-memory + Redis adapters) and, having full context the Task 0a
// seam-author didn't, refines the callable surface below: `create()`
// replaces the original placeholder `put()` because generating and
// idempotently persisting a keypair is one operation the *store* must own
// (the registry — a runtime-neutral caller — must never touch raw key
// material or a KEK), and `get`/`getByActor` return a public projection only,
// per the security requirement that nothing but `takeCustody()` ever returns
// private-key material. Custodial keypair at birth, dormant, per #5: private
// keys are encrypted at rest, never logged, never returned by any API except
// the one-shot `takeCustody()`.

/** One seat's custodial keypair row, as persisted at rest. Nothing here ever signs. */
export const SeatKeyRecordSchema = z.object({
  seatKeyId: z.string().min(1),
  /** Owner→seat binding, recorded when provided at creation; never enforced. */
  ownerAccountId: z.string().min(1).optional(),
  publicKey: z.string().min(1),
  /** Encrypted at rest under the store's KEK; only `takeCustody()` ever decrypts it. */
  encryptedPrivateKey: z.string().min(1),
  /** Set once `takeCustody()` has exported the key; `null` while custodied. */
  exportedAt: z.string().nullable(),
});
export type SeatKeyRecord = z.infer<typeof SeatKeyRecordSchema>;

/**
 * Public projection of a key row — everything `create`/`get`/`getByActor`
 * return. Never carries private-key material in any form.
 */
export const SeatKeyPublicRecordSchema = SeatKeyRecordSchema.omit({
  encryptedPrivateKey: true,
});
export type SeatKeyPublicRecord = z.infer<typeof SeatKeyPublicRecordSchema>;

export interface SeatKeyCreateOptions {
  /** Recorded on the key row when provided at creation; never enforced. */
  ownerAccountId?: string;
}

/** Callable surface of the `seat.keyStore` port. No method here ever signs. */
export const SeatKeyStoreContract = z.object({
  /**
   * Idempotently materializes one actor identity's custodial keypair: an
   * identity that already has a key row never regenerates, so this is safe
   * to call on every turn/read that might be the identity's first.
   */
  create: z.custom<
    (
      actor: ActorId,
      options?: SeatKeyCreateOptions,
    ) => Promise<SeatKeyPublicRecord>
  >(value => typeof value === 'function', {
    message: 'create must be a function',
  }),
  get: z.custom<
    (seatKeyId: string) => Promise<SeatKeyPublicRecord | undefined>
  >(value => typeof value === 'function', {message: 'get must be a function'}),
  getByActor: z.custom<
    (actor: ActorId) => Promise<SeatKeyPublicRecord | undefined>
  >(value => typeof value === 'function', {
    message: 'getByActor must be a function',
  }),
  /** One-shot: returns the decrypted private key exactly once, then marks the row exported. */
  takeCustody: z.custom<(seatKeyId: string) => Promise<string>>(
    value => typeof value === 'function',
    {message: 'takeCustody must be a function'},
  ),
});
export type SeatKeyStore = z.infer<typeof SeatKeyStoreContract>;

export const SEAT_KEY_STORE = BindingKey.create<SeatKeyStore>('seat.keyStore');

/**
 * Key-encryption key (KEK) for the store's AES-256-GCM at-rest encryption of
 * private-key material. Must decode to exactly 32 bytes; a missing or
 * mis-sized KEK is a construction-time error for every adapter, never a
 * silent fallback.
 */
export const SEAT_KEY_STORE_KEK = BindingKey.create<Buffer | string>(
  'seat.keyStore.kek',
);

export interface ActorClassMetadata {
  name: string;
  state: ZodType<unknown>;
  /** Deadline band for this actor's turns. Default `'capability'`. */
  seatClass?: ActorSeatClass;
  /** Explicit per-turn deadline in ms. Overrides the seat class's default. */
  deadlineMs?: number;
}

export interface ActorCommandMetadata {
  name: string;
  input: ZodType<unknown>;
  output: ZodType<unknown>;
  methodName: string | symbol;
}

export interface ActorQueryMetadata {
  name: string;
  input: ZodType<unknown>;
  output: ZodType<unknown>;
  methodName: string | symbol;
}

export namespace ActorMetadata {
  export const CLASS = MetadataAccessor.create<
    ActorClassMetadata,
    ClassDecorator
  >('actors:class');
  export const COMMAND = MetadataAccessor.create<
    ActorCommandMetadata,
    MethodDecorator
  >('actors:command');
  export const QUERY = MetadataAccessor.create<
    ActorQueryMetadata,
    MethodDecorator
  >('actors:query');
}
