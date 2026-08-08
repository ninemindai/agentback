// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {TurnTimeoutError, type ActorId} from '@agentback/actors';

/** One command turn, as sent to the identity's Durable Object. */
export interface TurnRequest {
  readonly actor: ActorId;
  readonly requestId: string;
  /** Already parsed by the caller's schema copy; the object re-parses too. */
  readonly command: unknown;
}

/**
 * An error carried across the RPC boundary. Structured clone flattens error
 * subclasses to bare `Error`s, so the object never throws domain errors at
 * the stub — it returns one of these and the caller side revives it.
 *
 * A turn timeout is its own kind because the caller must receive a real
 * `TurnTimeoutError` (callers and the conformance suite classify on
 * `instanceof` and read `actor`/`requestId`/`deadlineMs` off it — including a
 * nested inner timeout passing through an outer turn, which must keep naming
 * the inner identity).
 */
export type WireActorError =
  | {
      readonly kind: 'timeout';
      readonly actor: ActorId;
      readonly requestId: string;
      readonly deadlineMs: number;
    }
  | {
      readonly kind: 'error';
      readonly name: string;
      readonly message: string;
      /**
       * JSON-portable own enumerable properties (`code`, `status`, `hint`,
       * ...), reassigned on revival so a domain error like `AgentError` keeps
       * the fields the REST/MCP error envelopes read.
       */
      readonly properties: Record<string, unknown>;
    };

export type TurnOutcome =
  | {readonly ok: true; readonly result: unknown}
  | {readonly ok: false; readonly error: WireActorError};

export type ReadStateOutcome =
  | {readonly ok: true; readonly state: unknown}
  | {readonly ok: false; readonly error: WireActorError};

function jsonPortable(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value as number);
  if (type !== 'object') return false;
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

/** Flatten any thrown value into a `WireActorError`. */
export function serializeActorError(err: unknown): WireActorError {
  if (err instanceof TurnTimeoutError) {
    return {
      kind: 'timeout',
      actor: err.actor,
      requestId: err.requestId,
      deadlineMs: err.deadlineMs,
    };
  }
  if (err instanceof Error) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(err)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      if (jsonPortable(value)) {
        properties[key] = JSON.parse(JSON.stringify(value)) as unknown;
      }
    }
    return {kind: 'error', name: err.name, message: err.message, properties};
  }
  return {
    kind: 'error',
    name: 'Error',
    message: String(err),
    properties: {},
  };
}

/** Revive a `WireActorError` into the error the caller should see thrown. */
export function reviveActorError(wire: WireActorError): Error {
  if (wire.kind === 'timeout') {
    return new TurnTimeoutError(wire.actor, wire.requestId, wire.deadlineMs);
  }
  const error = new Error(wire.message);
  error.name = wire.name;
  Object.assign(error, wire.properties);
  return error;
}
