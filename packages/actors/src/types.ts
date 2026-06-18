// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ZodType} from 'zod';

/** Stable identity of one logical actor instance. */
export interface ActorId {
  readonly type: string;
  readonly id: string;
}

/** Metadata for one command delivery. */
export interface ActorCommandContext {
  readonly actor: ActorId;
  readonly requestId: string;
}

/** State and reply produced by one successful actor turn. */
export interface ActorTurn<S, R> {
  state: S;
  result: R;
}

/** Service-class contract used by the decorated actor authoring model. */
export interface Actor<S> {
  initialState(id: string): S | Promise<S>;
}

/** Runtime envelope produced by an `@actorCommand` method. */
export interface ActorServiceCommand {
  name: string;
  input: unknown;
}

/** Runtime envelope returned by an `@actorCommand` method. */
export interface ActorServiceResult {
  name: string;
  output: unknown;
}

/**
 * Typed actor behavior. A runtime must serialize `receive` calls per actor ID
 * and commit state only after both state and result pass validation.
 */
export interface ActorDefinition<S, C, R> {
  readonly name: string;
  readonly state: ZodType<S>;
  /** Commands must decode to JSON-serializable values for adapter portability. */
  readonly command: ZodType<C>;
  readonly result: ZodType<R>;
  readonly initialState: (id: string) => S | Promise<S>;
  readonly receive: (
    ctx: ActorCommandContext,
    state: S,
    command: C,
  ) => ActorTurn<S, R> | Promise<ActorTurn<S, R>>;
  readonly __kind: 'actor';
}

export interface DefineActorOptions<S, C, R> {
  state: ZodType<S>;
  command: ZodType<C>;
  result: ZodType<R>;
  initialState: (id: string) => S | Promise<S>;
  receive: ActorDefinition<S, C, R>['receive'];
}

/** Options controlling one actor command. */
export interface ActorInvokeOptions {
  /** Idempotency key. Reusing it returns the committed result without rerun. */
  requestId?: string;
}

/** Typed, location-independent handle to one actor identity. */
export interface ActorRef<C, R> {
  readonly actor: ActorId;
  invoke(command: C, options?: ActorInvokeOptions): Promise<R>;
}

/**
 * Actor hosting seam. Durable/distributed adapters must preserve the same
 * per-ID serialization, rollback, validation, and request-dedup semantics.
 */
export interface ActorRuntime {
  register<S, C, R>(definition: ActorDefinition<S, C, R>): void;
  ref<S, C, R>(
    definition: ActorDefinition<S, C, R>,
    id: string,
  ): ActorRef<C, R>;
  state<S, C, R>(definition: ActorDefinition<S, C, R>, id: string): Promise<S>;
}
