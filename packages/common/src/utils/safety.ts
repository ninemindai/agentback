// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {randomUUID} from 'node:crypto';

/**
 * Safety primitives for handing APIs to agents: confirmation tokens for
 * dangerous operations (`confirm:` on REST routes and MCP tools) and
 * idempotency-key replay for mutations (`idempotency:` on REST routes).
 * The in-memory implementations below are per-process; multi-instance
 * deployments bind a shared-store implementation in their place.
 */

/** Deterministic JSON serialization (sorted object keys) for fingerprints. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Issues and verifies single-use confirmation tokens. A token is bound to a
 * `scope` (the operation) and a `fingerprint` (the exact request payload),
 * so the confirmed call must be byte-identical to the proposed one — an
 * agent cannot confirm one mutation and execute another.
 */
export interface ConfirmationStore {
  /** Issue a token for one (scope, fingerprint) pair. */
  issue(scope: string, fingerprint: string, ttlMs?: number): string;
  /**
   * Verify and CONSUME a token. Returns false when the token is unknown,
   * expired, or was issued for a different scope/fingerprint.
   */
  verify(token: string, scope: string, fingerprint: string): boolean;
}

export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60_000;

/** Per-process {@link ConfirmationStore}; tokens are single-use UUIDs. */
export class InMemoryConfirmationStore implements ConfirmationStore {
  private tokens = new Map<
    string,
    {scope: string; fingerprint: string; expiresAt: number}
  >();

  issue(
    scope: string,
    fingerprint: string,
    ttlMs = DEFAULT_CONFIRMATION_TTL_MS,
  ): string {
    this.prune();
    const token = randomUUID();
    this.tokens.set(token, {
      scope,
      fingerprint,
      expiresAt: Date.now() + ttlMs,
    });
    return token;
  }

  verify(token: string, scope: string, fingerprint: string): boolean {
    const entry = this.tokens.get(token);
    if (!entry) return false;
    this.tokens.delete(token); // single-use, even on mismatch
    return (
      entry.expiresAt > Date.now() &&
      entry.scope === scope &&
      entry.fingerprint === fingerprint
    );
  }

  private prune() {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt <= now) this.tokens.delete(token);
    }
  }
}

/**
 * Executes an operation at most once per idempotency key. A replayed key
 * returns the original result without re-running the operation; concurrent
 * calls with the same key share one in-flight execution. Failures are NOT
 * cached — a retry after an error re-executes.
 */
export interface IdempotencyStore {
  execute(
    key: string,
    run: () => Promise<unknown>,
    ttlMs?: number,
  ): Promise<{replayed: boolean; result: unknown}>;
}

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;

/** Per-process {@link IdempotencyStore} (result cache + in-flight dedupe). */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private entries = new Map<
    string,
    {promise: Promise<unknown>; expiresAt: number}
  >();

  async execute(
    key: string,
    run: () => Promise<unknown>,
    ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  ): Promise<{replayed: boolean; result: unknown}> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      return {replayed: true, result: await existing.promise};
    }
    const promise = run();
    this.entries.set(key, {promise, expiresAt: Date.now() + ttlMs});
    try {
      const result = await promise;
      return {replayed: false, result};
    } catch (err) {
      // Errors are not replayable: drop the entry so a retry re-executes.
      this.entries.delete(key);
      throw err;
    }
  }

  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
