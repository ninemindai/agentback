// Copyright NineMind, Inc. 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describeInjectedArguments} from '@agentback/context';
import {MethodDecoratorFactory} from '@agentback/metadata';
import type {InferSchema, SchemaLike} from '@agentback/openapi';
import {EventMetadata, MCPKeys} from '../keys.js';

/** Options shared by every `@event` overload. */
export interface EventOptionsBase<P extends SchemaLike> {
  /**
   * Schema of the occurrence's `data` — published as `payloadSchema` and
   * validated at emit time. Must lower to an object root. Keep it minimal:
   * deliveries are capped at 256 KiB, so send a summary plus the id a read
   * tool takes, never a whole record — and never instructions for a model.
   */
  payload: P;
  description?: string;
  title?: string;
  /**
   * OAuth scope required to see and subscribe to this event over an
   * authenticated transport, exactly as `@tool({scope})`.
   */
  scope?: string;
}

export interface EventOptions<
  I extends SchemaLike,
  P extends SchemaLike,
> extends EventOptionsBase<P> {
  /**
   * Schema of the subscription `arguments` — published as `inputSchema` and
   * validated on `events/subscribe`. Must lower to an object root.
   */
  input: I;
}

/**
 * Declare an MCP Events event type. The decorated method is the
 * subscription filter: emitting `data` delivers it to each live
 * subscription whose `match(args, data)` returns `true` — anything else,
 * including `undefined` or a thrown error, is "no match", so a filter bug
 * under-delivers rather than leaking another subscriber's events.
 *
 * Slot 0 is the subscription's validated `arguments` and slot 1 the
 * validated `data`; `@inject(...)` parameters may follow at slot 2+. While
 * `match` runs, `SecurityBindings.USER` is the subscriber, so the filter can
 * also check that this principal may see this particular occurrence.
 *
 * Emit with the port at `MCPBindings.EVENTS`:
 * `events.emit('comment.created', data, {eventId})`.
 *
 * @example
 *   const Filter = z.object({document_id: z.string()});
 *   const Created = z.object({document_id: z.string(), comment_id: z.string()});
 *
 *   @event('comment.created', {input: Filter, payload: Created})
 *   matches(args: z.infer<typeof Filter>, e: z.infer<typeof Created>) {
 *     return e.document_id === args.document_id;
 *   }
 */
// Overload 1: input + payload → type both slots. The method type is inferred
// (`M`) rather than fixed, so a filter that ignores its trailing parameters —
// `archived() { return true; }` — is accepted, as any shorter callback is.
export function event<I extends SchemaLike, P extends SchemaLike>(
  name: string,
  options: EventOptions<I, P>,
): <
  M extends (
    args: InferSchema<I>,
    data: InferSchema<P>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...rest: any[]
  ) => boolean | Promise<boolean>,
>(
  target: object,
  methodName: string | symbol,
  desc: TypedPropertyDescriptor<M>,
) => void;

// Overload 2: payload only → the event takes no arguments.
export function event<P extends SchemaLike>(
  name: string,
  options: EventOptionsBase<P>,
): <
  M extends (
    args: Record<string, never>,
    data: InferSchema<P>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...rest: any[]
  ) => boolean | Promise<boolean>,
>(
  target: object,
  methodName: string | symbol,
  desc: TypedPropertyDescriptor<M>,
) => void;

export function event(
  name: string,
  options: EventOptionsBase<SchemaLike> & {input?: SchemaLike},
): MethodDecorator {
  return function eventDecorator(
    target: object,
    methodName: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const where = () =>
      `@event('${name}') on ${
        (target as {constructor?: {name: string}}).constructor?.name ??
        'anonymous'
      }.${String(methodName)}`;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${where()}: the event name must be a non-empty string`);
    }
    if (options?.payload == null) {
      throw new Error(
        `${where()}: payload: is required — it is the event's payloadSchema`,
      );
    }
    // Slots 0 and 1 are the validated arguments and data.
    const injected = describeInjectedArguments(target, methodName as string);
    if (injected[0] != null || injected[1] != null) {
      throw new Error(
        `${where()}: slots 0 and 1 are reserved for the subscription ` +
          `arguments and the event data. Move @inject(...) to slot 2+.`,
      );
    }
    const meta: EventMetadata = {
      name,
      description: options.description,
      title: options.title,
      input: options.input,
      payload: options.payload,
      scope: options.scope,
      methodName,
    };
    MethodDecoratorFactory.createDecorator<EventMetadata>(MCPKeys.EVENT, meta, {
      decoratorName: '@event',
    })(target, methodName, descriptor);
  };
}
