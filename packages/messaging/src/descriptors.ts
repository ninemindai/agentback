// Copyright ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import type {ZodType} from 'zod';

/** A typed work-queue identity: name + payload schema travel together. */
export interface QueueDescriptor<T> {
  readonly name: string;
  readonly schema: ZodType<T>;
  readonly __kind: 'queue';
}

/** A typed pub/sub topic identity: name + event schema travel together. */
export interface TopicDescriptor<E> {
  readonly name: string;
  readonly schema: ZodType<E>;
  readonly __kind: 'topic';
}

/** Define a queue descriptor. Payload type is inferred from the Zod schema. */
export function defineQueue<T>(
  name: string,
  schema: ZodType<T>,
): QueueDescriptor<T> {
  return {name, schema, __kind: 'queue'};
}

/** Define a topic descriptor. Event type is inferred from the Zod schema. */
export function defineTopic<T>(
  name: string,
  schema: ZodType<T>,
): TopicDescriptor<T> {
  return {name, schema, __kind: 'topic'};
}
