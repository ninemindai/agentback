// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ActorId, CommittedActorEvent} from '@agentback/actors';
import type {ReadStateOutcome, TurnOutcome, TurnRequest} from './protocol.js';

/**
 * The slice of Durable Object storage this adapter uses, as a structural type
 * so the package depends on no Cloudflare type definitions. Deliberately the
 * **portable intersection**: every member exists with these semantics on
 * Cloudflare's Durable Objects and on celld (the self-hosted DO runtime), and
 * on the in-process host used for tests and single-process runs.
 *
 * `put` takes a record of entries and MUST apply them atomically — that is
 * the documented behavior of the multi-key `put` on Durable Object storage,
 * and it is the adapter's one commit primitive: state, dedup record, and
 * journal entries advance together or not at all.
 */
export interface ActorDoStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  /** Keys returned in ascending (UTF-8) key order, as DO storage lists. */
  list<T = unknown>(options: {prefix: string}): Promise<Map<string, T>>;
}

/**
 * The slice of the Durable Object state/context handed to the class
 * constructor. On Cloudflare/celld this is the real `DurableObjectState`
 * (which satisfies it structurally); the in-process host passes a minimal
 * object.
 */
export interface ActorDoState {
  readonly storage: ActorDoStorage;
}

/**
 * The RPC surface an actor Durable Object exposes and its stub proxies.
 * Methods return plain JSON envelopes rather than throwing, because RPC
 * serialization (structured clone across isolates) does not preserve error
 * subclasses — a thrown `TurnTimeoutError` would arrive as a bare `Error`.
 * See `protocol.ts` for the envelope shapes and revival.
 */
export interface ActorDoStub {
  turn(request: TurnRequest): Promise<TurnOutcome>;
  /** Lease-free read; carries the identity so a cold read can compute
   * `initialState` without storing it. */
  readState(actor: ActorId): Promise<ReadStateOutcome>;
  readEvents(): Promise<CommittedActorEvent[]>;
}

/**
 * The Durable Object namespace binding, structurally. On Cloudflare this is
 * the `env.<BINDING>` object for the class; `idFromName` + `get` is the only
 * addressing path the adapter uses (one object per actor identity).
 */
export interface ActorDoNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): ActorDoStub;
}
