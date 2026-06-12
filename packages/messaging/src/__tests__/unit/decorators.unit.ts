// Copyright Ninemind.ai 2026. All Rights Reserved.
// This file is licensed under the MIT License.
// License text available at https://opensource.org/license/mit/

import {describe, it, expect} from 'vitest';
import {z} from 'zod';
import {MetadataInspector} from '@agentback/metadata';
import {defineQueue, defineTopic} from '../../descriptors.js';
import {jobProcessor, subscriber} from '../../decorators.js';
import {
  JOB_PROCESSOR_METADATA_KEY,
  SUBSCRIBER_METADATA_KEY,
} from '../../keys.js';
import type {
  JobProcessorMetadata,
  SubscriberMetadata,
} from '../../decorators.js';

const Q = defineQueue('dec.jobs', z.object({n: z.number()}));
const T = defineTopic('dec.events', z.object({v: z.number()}));

describe('messaging decorators', () => {
  it('@jobProcessor stores descriptor + options on method metadata', () => {
    class W {
      @jobProcessor(Q, {concurrency: 4})
      run() {}
    }
    const meta = MetadataInspector.getAllMethodMetadata<JobProcessorMetadata>(
      JOB_PROCESSOR_METADATA_KEY,
      W.prototype,
    );
    expect(meta?.run.queueName).toBe('dec.jobs');
    expect(meta?.run.options?.concurrency).toBe(4);
  });

  it('@subscriber stores topic + group on method metadata', () => {
    class S {
      @subscriber(T, 'archive', {fromStart: true})
      on() {}
    }
    const meta = MetadataInspector.getAllMethodMetadata<SubscriberMetadata>(
      SUBSCRIBER_METADATA_KEY,
      S.prototype,
    );
    expect(meta?.on.topicName).toBe('dec.events');
    expect(meta?.on.group).toBe('archive');
    expect(meta?.on.options?.fromStart).toBe(true);
  });
});
